/** Kotlin DSL is a configuration language, not evidence of Kotlin application code. */
export function gradleBuildKind(content) {
  const declared = String(content ?? '');
  const has = (target) => new RegExp(
    `kotlin\\s*\\(\\s*["']${target}["']\\s*\\)|org\\.jetbrains\\.kotlin\\.${target}`, 'u'
  ).test(declared);
  const multiplatform = has('multiplatform');
  // Kotlin on Android, however it is applied: kotlin("android"), the plugin id, a version-catalog
  // alias (libs.plugins.kotlin.android, libs.plugins.kotlinAndroid) or Groovy's 'kotlin-android'.
  const kotlinAndroid = has('android')
    || /\blibs\.plugins\.(?:jetbrains\.)?kotlin[.-]?android\b/iu.test(declared)
    || /["']kotlin-android["']/u.test(declared);
  // The Android Gradle plugin itself, with or without Kotlin: any com.android.* plugin id
  // (application, library, test, dynamic-feature) or a catalog alias such as libs.plugins.android.application.
  const android = kotlinAndroid
    || /["']com\.android\.[A-Za-z][A-Za-z.-]*["']/u.test(declared)
    || /\blibs\.plugins\.android(?:[.-][a-z]|[A-Z])/u.test(declared) || /^\s*android\s*\{/mu.test(declared);
  return {
    stack: multiplatform ? 'kotlin-multiplatform' : kotlinAndroid ? 'kotlin-android' : android ? 'android-gradle'
      : has('jvm') ? 'kotlin-gradle' : 'java-gradle',
    // An Android module's unit tests run per variant (testDebugUnitTest) [TCE:REQ-075]; a multiplatform
    // build's target (jvmTest, allTests) is a person's choice.
    requiresTestTarget: multiplatform,
    android: android && !multiplatform
  };
}

/** The variant an Android module's tests run: Debug, or null when product flavors make several. */
export function androidTestVariant(content) {
  return /\b(?:productFlavors|flavorDimensions)\b/u.test(String(content ?? '')) ? null : 'Debug';
}

export const GRADLE_TEST_TARGET_REASON = 'Kotlin multiplatform builds, and Android builds with product flavors, require an explicit test target (for example jvmTest or testFreeDebugUnitTest); the JVM test task cannot be assumed.';
