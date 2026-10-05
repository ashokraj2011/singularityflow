import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
import java.security.MessageDigest

plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.intellij.platform")
}

group = providers.gradleProperty("group").get()
version = providers.gradleProperty("pluginVersion").get()

// Optional: an installed IDE to build, verify and run against instead of downloading one, e.g.
// -PsflowLocalIde="/Applications/IntelliJ IDEA.app". It must be IntelliJ 2025.3 (build 253) or newer.
val localIde = providers.gradleProperty("sflowLocalIde")
// Optional: comma-separated installed or cached IDEs to verify against, instead of downloading the matrix.
val verifyIdes = providers.gradleProperty("sflowVerifyIdes")

kotlin {
    jvmToolchain(21)
    compilerOptions {
        // IntelliJ 2025.3 bundles Kotlin stdlib 2.2: never compile against newer stdlib API.
        apiVersion.set(KotlinVersion.KOTLIN_2_2)
        languageVersion.set(KotlinVersion.KOTLIN_2_2)
        // Use the platform interfaces' JVM default methods directly; compatibility bridges would
        // override and call deprecated defaults (StatusBarWidget.getPresentation and others).
        jvmDefault.set(JvmDefaultMode.NO_COMPATIBILITY)
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")

    intellijPlatform {
        if (localIde.isPresent) local(localIde.get()) else intellijIdea("2025.3.6.1")
        bundledPlugin("org.jetbrains.plugins.terminal")
        testFramework(TestFrameworkType.Platform)
    }
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = "253"
            // Unset, so Android Studio and IDEA releases newer than the build target still load it.
            untilBuild = provider { null }
        }
    }
    pluginVerification {
        ides {
            if (verifyIdes.isPresent) {
                verifyIdes.get().split(',').map { it.trim() }.filter { it.isNotEmpty() }.forEach { local(file(it)) }
            } else if (localIde.isPresent) {
                local(file(localIde.get()))
            } else {
                create(IntelliJPlatformType.IntellijIdea, "2025.3.6.1")
                create(IntelliJPlatformType.IntellijIdea, "2026.2.1")
                create(IntelliJPlatformType.AndroidStudio, "2025.3.4.6")
                create(IntelliJPlatformType.AndroidStudio, "2026.1.4.7")
                create(IntelliJPlatformType.AndroidStudio, "2026.2.1.8")
            }
        }
    }
}

// Machine-level sflow stores for a sandboxed manual run: -PsflowSandbox=<directory> points every
// store the CLI reads at that directory, so the IDE never shows or changes ~/.singularity-flow.
// -PsflowCli=<path to bin/singularity-flow.mjs> makes the plugin run that CLI, e.g. this checkout's.
fun sandboxEnvironment(): Map<String, String> {
    val sandbox = providers.gradleProperty("sflowSandbox").orNull ?: return emptyMap()
    val cli = providers.gradleProperty("sflowCli").orNull
    return mapOf(
        "SINGULARITY_FLOW_ACTIVE_WORKSPACE" to "$sandbox/home/active-workspace.json",
        "SINGULARITY_FLOW_WORKSPACE_REGISTRY" to "$sandbox/home/workspaces.json",
        "SINGULARITY_FLOW_LEAD_REGISTRY" to "$sandbox/home/leads.json",
        "SINGULARITY_FLOW_LOCAL_JOURNAL" to "$sandbox/home/journal",
        "SINGULARITY_FLOW_REPOSITORY_CATALOG" to "$sandbox/home/repository-catalog",
        "SINGULARITY_FLOW_TEST_IDENTITY" to "Contract Tester"
    ) + (if (cli != null) mapOf("SINGULARITY_FLOW_CLI" to cli) else emptyMap())
}

// -PsflowOpen=<directory> opens that project when a run task starts the IDE.
val openProject = providers.gradleProperty("sflowOpen")

tasks.named<org.jetbrains.intellij.platform.gradle.tasks.RunIdeTask>("runIde") {
    environment(sandboxEnvironment())
    if (openProject.isPresent) args(openProject.get())
}

intellijPlatformTesting.runIde {
    register("runLocalIde") {
        localPath = localIde.map { file(it) }
        task {
            environment(sandboxEnvironment())
            if (openProject.isPresent) args(openProject.get())
        }
    }
    register("runAndroidStudio") {
        type = IntelliJPlatformType.AndroidStudio
        version = "2026.2.1.8"
        task {
            environment(sandboxEnvironment())
            // Skip the first-run wizard, which would download Android SDK components.
            systemProperty("disable.android.first.run", "true")
            if (openProject.isPresent) args(openProject.get())
        }
    }
}

// The verified zip and its SHA-256 for a GitHub release: ./gradlew releaseZip, from a clean checkout.
tasks.register("releaseZip") {
    description = "Builds and verifies the plugin, then writes the zip and its SHA-256 to build/release."
    dependsOn("verifyPlugin")
    val zip = tasks.named<Zip>("buildPlugin").flatMap { it.archiveFile }
    val output = layout.buildDirectory.dir("release")
    inputs.file(zip)
    outputs.dir(output)
    doLast {
        val source = zip.get().asFile
        val target = output.get().asFile.resolve(source.name)
        source.copyTo(target, overwrite = true)
        val digest = MessageDigest.getInstance("SHA-256").digest(target.readBytes())
            .joinToString("") { "%02x".format(it) }
        target.resolveSibling("${target.name}.sha256").writeText("$digest  ${target.name}\n")
        println("Wrote $target (sha256:$digest)")
    }
}
