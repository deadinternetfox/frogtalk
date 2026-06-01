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
        versionCode = 252
        versionName = "1.6.46-alpha"
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

// okhttp 4.12 → okio 3.6 (the screen-share signaling stack) is compiled against
// Kotlin 2.0, which bumps the transitive kotlin stdlib to 2.0.x. From Kotlin 2.0
// `kotlin-stdlib-common` is published as metadata only (no downloadable JVM
// artifact), so dependency locking can't resolve its file and the build fails
// with "Did not resolve kotlin-stdlib-common … part of the dependency lock
// state". Its classes are already inside kotlin-stdlib, so drop the redundant
// standalone module everywhere.
configurations.all {
    exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-common")
}

val officialNodeDefaults = rootProject.file("../../official-node.json")

tasks.register<Copy>("copyOfficialNodeDefaults") {
    from(officialNodeDefaults)
    into(layout.projectDirectory.dir("src/main/assets"))
    onlyIf { officialNodeDefaults.isFile }
}

tasks.named("preBuild") {
    dependsOn("copyOfficialNodeDefaults")
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
    // Native screen share: WebRTC peer (MediaProjection → sendonly screen track)
    // joining an in-call as a second connection, plus an OkHttp WebSocket for the
    // screen_* signaling. webrtc-sdk is the maintained org.webrtc Maven mirror.
    implementation("io.github.webrtc-sdk:android:125.6422.07")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
