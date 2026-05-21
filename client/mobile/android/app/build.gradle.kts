import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")
}

android {
    namespace = "xyz.frogtalk.app"
    compileSdk = 35

    signingConfigs {
        create("release") {
            // Signing credentials are read from gradle.properties (in
            // ~/.gradle/ or under android/, NEVER committed) or from
            // environment variables (CI). If neither is present we fall
            // back to a placeholder so :assembleDebug still works — but
            // :assembleRelease will fail at sign time, which is the
            // correct behaviour for a missing secret.
            val propsFile = rootProject.file("signing.properties")
            val props = Properties().apply {
                if (propsFile.exists()) propsFile.inputStream().use { load(it) }
            }
            val storePath = props.getProperty("storeFile")
                ?: System.getenv("FROGTALK_KEYSTORE")
                ?: "../frogtalk.keystore"
            storeFile = file(storePath)
            storePassword = props.getProperty("storePassword")
                ?: System.getenv("FROGTALK_KEYSTORE_PASSWORD")
                ?: ""
            keyAlias = props.getProperty("keyAlias")
                ?: System.getenv("FROGTALK_KEY_ALIAS")
                ?: "frogtalk"
            keyPassword = props.getProperty("keyPassword")
                ?: System.getenv("FROGTALK_KEY_PASSWORD")
                ?: ""
        }
    }

    defaultConfig {
        applicationId = "xyz.frogtalk.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 234
        versionName = "1.6.29"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            ndk {
                debugSymbolLevel = "FULL"
            }
        }
        debug {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = false
    }

    // Gradle dependency locking — captures the full resolved
    // dependency graph into lockfiles under android/app/, so a future
    // build can't silently pick up a tampered transitive dependency.
    // Regenerate with:
    //   ./gradlew :app:dependencies --write-locks
    dependencyLocking {
        lockAllConfigurations()
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.activity:activity-ktx:1.8.2")
    implementation("androidx.webkit:webkit:1.9.0")
    implementation("androidx.media:media:1.7.0")
    implementation(platform("com.google.firebase:firebase-bom:34.12.0"))
    implementation("com.google.firebase:firebase-messaging")
}
