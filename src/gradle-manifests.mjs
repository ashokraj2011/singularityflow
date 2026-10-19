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
    || /\blibs\.plugins\.android(?:[.-][a-z]|[A-Z])/u.test(declared);
  return {
    stack: multiplatform ? 'kotlin-multiplatform' : kotlinAndroid ? 'kotlin-android' : android ? 'android-gradle'
      : has('jvm') ? 'kotlin-gradle' : 'java-gradle',
    requiresTestTarget: multiplatform || android
  };
}

export const GRADLE_TEST_TARGET_REASON = 'Android and Kotlin multiplatform builds require an explicit test target (for example testDebugUnitTest); the JVM test task cannot be assumed.';
