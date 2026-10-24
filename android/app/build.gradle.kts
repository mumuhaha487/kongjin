import java.util.Properties
import java.time.Instant

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val developerKeyFile = rootProject.file("keystore.properties")
val privateKeyFile = rootProject.file("../keys/kongjing-android.txt")
val keyFile = if (developerKeyFile.isFile) developerKeyFile else privateKeyFile
val signing = Properties().apply { if (keyFile.isFile) keyFile.inputStream().use { load(it) } }
val signingStore = signing.getProperty("storeFile")?.let { rootProject.file(it) }
    ?: rootProject.file("../keys/kongjing-android.jks")
val hasSigning = keyFile.isFile && signingStore.isFile
android {
    namespace = "re.inc.kongjing.browser"
    compileSdk = 35
    defaultConfig {
        applicationId = "re.inc.kongjing.browser"
        minSdk = 26
        targetSdk = 35
        versionCode = 12
        versionName = "1.4.2"
        buildConfigField("boolean", "WEBVIEW_INSPECT", "false")
    }
    signingConfigs {
        create("release") {
            storeFile = signingStore
            storePassword = signing.getProperty("storePassword")
            keyAlias = signing.getProperty("keyAlias", "kongjing")
            keyPassword = signing.getProperty("keyPassword")
            enableV1Signing = false
            enableV2Signing = true
            enableV3Signing = true
        }
    }
    buildTypes {
        debug { if (hasSigning) signingConfig = signingConfigs.getByName("release") }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        create("diagnostic") {
            initWith(getByName("release"))
            matchingFallbacks += "release"
            buildConfigField("boolean", "WEBVIEW_INSPECT", "true")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
    lint { abortOnError = true; checkReleaseBuilds = true }
    testOptions { unitTests.isReturnDefaultValues = true }
}

val realHome = rootProject.file(providers.gradleProperty("homeSourceDir").getOrElse("../extension/dist-android"))
val usePlaceholder = providers.gradleProperty("allowPlaceholderHome").map(String::toBoolean).orElse(false)
val continuityMock = providers.gradleProperty("continuityMockHome").map(String::toBoolean).orElse(false)
val validateHome by tasks.registering {
    doLast {
        if (!continuityMock.get() && !(usePlaceholder.get() && !realHome.resolve("READY.md").isFile) &&
            (!realHome.resolve("READY.md").isFile || !realHome.resolve("index.html").isFile)) {
            throw GradleException("真实安卓主页尚未就绪：需要 extension/dist-android/READY.md 和 index.html。仅调试可用 -PallowPlaceholderHome=true。")
        }
    }
}
val copyHome by tasks.registering(Sync::class) {
    dependsOn(validateHome)
    val development = usePlaceholder.get() && !realHome.resolve("READY.md").isFile
    from(if (continuityMock.get()) rootProject.file("dev-home-continuity") else if (development) rootProject.file("dev-home") else realHome)
    into(layout.projectDirectory.dir("src/main/assets/home"))
    doFirst {
        if (!continuityMock.get() && !development && (!realHome.resolve("READY.md").isFile || !realHome.resolve("index.html").isFile)) {
            throw GradleException("真实安卓主页尚未就绪：需要 extension/dist-android/READY.md 和 index.html。仅调试可用 -PallowPlaceholderHome=true。")
        }
    }
}
val validateReleaseHome by tasks.registering {
    doLast {
        check(!continuityMock.get() && !usePlaceholder.get()) { "发布包禁止 mock / 占位主页。" }
        check(realHome.resolve("READY.md").isFile && realHome.resolve("index.html").isFile &&
            (providers.gradleProperty("unpublishedCandidate").orNull == "true" ||
                realHome.resolve("READY.md").readText().let { it.contains("主页版本：2.4.0。") && it.contains("v3.3.1") && it.contains("setVisible") })) {
            "等待主页 2.4.0 与同步 v3.3.1；旧主页只允许显式 unpublishedCandidate 不发布候选构建。"
        }
    }
}
tasks.matching { it.name in setOf("packageRelease", "packageDiagnostic", "bundleRelease", "bundleDiagnostic") }
    .configureEach { dependsOn(validateReleaseHome) }
tasks.named("preBuild") { dependsOn(copyHome) }

tasks.matching { it.name == "assembleRelease" }.configureEach {
    doFirst {
        val lock = rootProject.file("test-state/DEVICE.lock")
        check(lock.isFile && System.currentTimeMillis() - lock.lastModified() < 3 * 60 * 60 * 1000) {
            "assembleRelease 前必须取得有效的雷电与发布构建 DEVICE.lock。"
        }
        check(layout.projectDirectory.file("src/main/assets/ext-runtime/runtime.js").asFile.let { it.isFile && it.length() > 1000 }) {
            "请先构建 android/extension-runtime 的本地运行时资产。"
        }
    }
}
tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    doFirst {
        check(realHome.resolve("READY.md").isFile && realHome.resolve("index.html").isFile) {
            "发布包禁止占位主页；等待 extension/dist-android/READY.md。"
        }
        check(hasSigning) { "发布需要 android/keystore.properties 指定自己的签名；更新必须使用原有签名。" }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.02.00"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("com.google.zxing:core:3.5.3")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
