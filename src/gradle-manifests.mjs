/** Kotlin DSL is a configuration language, not evidence of Kotlin application code. */
export function gradleBuildKind(content) {
  const declared = String(content ?? '');
  const has = (target) => new RegExp(
    `kotlin\\s*\\(\\s*["']${target}["']\\s*\\)|org\\.jetbrains\\.kotlin\\.${target}`, 'u'
  ).test(declared);
  const multiplatform = has('multiplatform');
  const android = has('android');
  return {
    stack: multiplatform ? 'kotlin-multiplatform' : android ? 'kotlin-android'
      : has('jvm') ? 'kotlin-gradle' : 'java-gradle',
    requiresTestTarget: multiplatform || android
  };
}

export const GRADLE_TEST_TARGET_REASON = 'Kotlin Android or multiplatform requires an explicit test target; the JVM test task cannot be assumed.';
