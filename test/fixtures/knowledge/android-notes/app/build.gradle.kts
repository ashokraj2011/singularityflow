plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.acme.app"
    defaultConfig { minSdk = 26 }
}

dependencies {
    implementation(project(":feature:notes"))
}
