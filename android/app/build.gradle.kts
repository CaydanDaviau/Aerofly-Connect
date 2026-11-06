plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val buildNumber: Int = (project.findProperty("buildNumber") as String?)?.toIntOrNull() ?: 1

android {
    namespace = "org.abflug.community"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.abflug.community"
        minSdk = 26
        targetSdk = 34
        versionCode = buildNumber
        versionName = "0.1.$buildNumber"
        buildConfigField("String", "SERVER_URL", "\"https://aeroflytest.caydanphoenix14.workers.dev\"")
    }

    // A fixed hobby key so every build can update the previous one in place.
    signingConfigs {
        create("community") {
            storeFile = file("../keystore/community.jks")
            storePassword = "abflugcommunity"
            keyAlias = "community"
            keyPassword = "abflugcommunity"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("community")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}
