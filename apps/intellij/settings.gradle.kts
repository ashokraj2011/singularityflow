import org.jetbrains.intellij.platform.gradle.extensions.intellijPlatform

rootProject.name = "singularity-flow-intellij"

pluginManagement {
    plugins {
        id("org.jetbrains.kotlin.jvm") version "2.4.20"
    }
}

plugins {
    // Downloads Java 21 for jvmToolchain(21) on machines that lack it.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
    id("org.jetbrains.intellij.platform.settings") version "2.19.0"
}

@Suppress("UnstableApiUsage")
dependencyResolutionManagement {
    repositories {
        mavenCentral()
        intellijPlatform {
            defaultRepositories()
        }
    }
}
