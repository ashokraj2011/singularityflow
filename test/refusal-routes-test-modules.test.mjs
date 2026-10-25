/**
 * Test-command resolution on repositories that are not one tidy module: a tooling package.json
 * beside pom.xml, Android Gradle builds, a multi-module build with one root wrapper, native builds
 * with no structured runner, and repository metadata no module owns. Each one either resolves to
 * an approved or inferred command or refuses with the route that configures one; none borrows an
 * unrelated module's tests as coverage.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  configuredTestModuleOverrides, inferModuleTestCommand, resolveAffectedModule, TEST_SETUP_COMMAND
} from '../src/code-delivery-tests.mjs';
import {
  resolveDeliveryQualityCommands, testCoverageDeliveryPaths, testCoverageExemptPath, uncoveredTestDeliveryPaths
} from '../src/delivery-evidence.mjs';
import { gradleBuildKind, GRADLE_TEST_TARGET_REASON } from '../src/gradle-manifests.mjs';
import { inspectRepositoryTestSetup } from '../src/repository-test-setup.mjs';

async function repository(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-modules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
  return root;
}

const NODE_TOOLING = JSON.stringify({ private: true, scripts: { test: 'node --test' } });
const configured = (affectedRoots = ['.']) => ({
  id: 'approved-maven-tests', kind: 'test', argv: ['./mvnw', 'test'], workingDirectory: '.', affectedRoots,
  modelPolicy: 'never', result: { adapter: 'junit-xml', path: 'target/surefire-reports', minimumDiscovered: 1 }
});
const codePhase = (deliveryEvidence, qualityCommands = []) => ({
  id: 'implement', generationPolicy: { task: 'code' }, qualityCommands, deliveryEvidence
});

test('two build systems in one directory refuse without a guess, and an approved command covering the path decides', async (t) => {
  const root = await repository(t, { 'pom.xml': '<project/>\n', 'package.json': NODE_TOOLING, 'src/main/java/App.java': 'class App {}\n' });
  await assert.rejects(resolveAffectedModule(root, 'src/main/java/App.java'), (error) => {
    assert.equal(error.code, 'TEST_MODULE_AMBIGUOUS');
    assert.deepEqual(error.details.systems, ['maven', 'node']);
    assert.deepEqual(error.details.nextAction, { command: TEST_SETUP_COMMAND });
    return true;
  });
  // An affected root of '.' owns the whole repository; a deeper one wins where it applies.
  const overrides = configuredTestModuleOverrides([configured(['.']), { ...configured(['src/main']), id: 'deeper' },
    { id: 'lint', kind: 'lint', argv: ['npm', 'run', 'lint'], affectedRoots: ['docs'] }]);
  assert.deepEqual(Object.keys(overrides).sort(), ['.', 'src/main']);
  assert.deepEqual(await resolveAffectedModule(root, 'pom.xml', { overrides }),
    { root: '.', system: 'configured', manifest: null, configured: true });
  assert.equal((await resolveAffectedModule(root, 'src/main/java/App.java', { overrides })).root, 'src/main');

  const delivery = { sourcePaths: ['src/main/java/App.java'], configurationPaths: [], testPaths: [] };
  await assert.rejects(resolveDeliveryQualityCommands(root, codePhase(delivery)), { code: 'TEST_MODULE_AMBIGUOUS' });
  const commands = await resolveDeliveryQualityCommands(root, codePhase(delivery, [configured()]));
  assert.deepEqual(commands.map((command) => command.id), ['approved-maven-tests'],
    'the approved command covers the path; no runner is inferred beside it');
});

test('repository metadata and CI configuration need no module of their own; everything else still does', async (t) => {
  for (const exempt of ['.gitignore', '.gitattributes', 'CODEOWNERS', '.github/workflows/ci.yml', '.gitlab-ci.yml', '.vscode/settings.json']) {
    assert.equal(testCoverageExemptPath(exempt), true, exempt);
  }
  for (const held of ['package.json', 'pom.xml', 'src/app.js', 'app/build.gradle.kts', 'Dockerfile']) {
    assert.equal(testCoverageExemptPath(held), false, held);
  }
  const delivery = { sourcePaths: ['services/api/src/App.java'], configurationPaths: ['.gitignore', '.github/workflows/ci.yml', 'tools/build.properties'] };
  assert.deepEqual(testCoverageDeliveryPaths(delivery), ['services/api/src/App.java', 'tools/build.properties']);
  assert.deepEqual(uncoveredTestDeliveryPaths(delivery, 'unrestricted', [{ affectedRoots: ['services/api'] }]), ['tools/build.properties']);

  // An exempt path in a directory with two build systems resolves to nothing instead of refusing.
  const root = await repository(t, { 'pom.xml': '<project/>\n', 'package.json': NODE_TOOLING,
    'services/api/package.json': NODE_TOOLING, 'services/api/index.js': 'export {};\n' });
  const commands = await resolveDeliveryQualityCommands(root, codePhase({
    sourcePaths: ['services/api/index.js'], configurationPaths: ['.gitignore', '.github/workflows/ci.yml'], testPaths: []
  }));
  assert.deepEqual(commands.map((command) => command.workingDirectory), ['services/api']);
});

test('a native build with no structured runner owns its files instead of borrowing the root package tests', async (t) => {
  const root = await repository(t, {
    'package.json': NODE_TOOLING, 'src/App.tsx': 'export {};\n',
    'ios/Podfile': "platform :ios, '16.0'\n", 'ios/App/AppDelegate.swift': 'import UIKit\n',
    'web/composer.json': '{}\n', 'web/package.json': NODE_TOOLING, 'web/app/Controller.php': '<?php\n', 'web/assets/app.js': 'export {};\n',
    'mobile/pubspec.yaml': 'name: mobile\n', 'mobile/lib/main.dart': 'void main() {}\n',
    'Gemfile': "source 'https://rubygems.org'\n", 'Rakefile': '', 'lib/task.rb': 'puts 1\n'
  });
  await assert.rejects(resolveAffectedModule(root, 'ios/App/AppDelegate.swift'), (error) => {
    assert.equal(error.code, 'TEST_MODULE_UNCOVERED');
    assert.equal(error.details.manifest, 'ios/Podfile');
    assert.match(error.message, /ios\/Podfile, a CocoaPods build with no supported structured test runner/u);
    assert.deepEqual(error.details.nextAction, { command: TEST_SETUP_COMMAND });
    return true;
  });
  await assert.rejects(resolveAffectedModule(root, 'mobile/lib/main.dart'), (error) => error.details.manifest === 'mobile/pubspec.yaml');
  // Beside a supported manifest a native one owns only its own language's files.
  await assert.rejects(resolveAffectedModule(root, 'web/app/Controller.php'), (error) => error.details.manifest === 'web/composer.json');
  assert.equal((await resolveAffectedModule(root, 'web/assets/app.js')).system, 'node');
  await assert.rejects(resolveAffectedModule(root, 'lib/task.rb'), (error) => error.details.manifest === 'Gemfile');
  assert.equal((await resolveAffectedModule(root, 'src/App.tsx')).system, 'node', 'a root Gemfile does not take JavaScript');

  const delivery = { sourcePaths: ['ios/App/AppDelegate.swift', 'src/App.tsx'], configurationPaths: [], testPaths: [] };
  await assert.rejects(resolveDeliveryQualityCommands(root, codePhase(delivery)), (error) =>
    error.code === 'TEST_MODULE_UNCOVERED' && error.details.manifest === 'ios/Podfile');
  // An approved command for the native module covers it.
  const xcode = { id: 'ios-tests', kind: 'test', argv: ['xcodebuild', 'test'], workingDirectory: 'ios', affectedRoots: ['ios'],
    modelPolicy: 'never', result: { adapter: 'junit-xml', path: 'build/reports', minimumDiscovered: 1 } };
  const commands = await resolveDeliveryQualityCommands(root, codePhase(delivery, [xcode]));
  assert.deepEqual(commands.map((command) => command.id).sort(), ['.-node-tests', 'ios-tests']);
  assert.deepEqual(uncoveredTestDeliveryPaths(delivery, 'unrestricted', commands), []);
  // Inspection names the native owner as a diagnostic instead of crashing.
  const setup = await inspectRepositoryTestSetup(root, { sourceRoots: ['ios'] });
  assert.equal(setup.diagnostics[0].code, 'TEST_MODULE_UNCOVERED');
});

test('Android builds are recognised however the plugin is applied, and run their variant\'s unit tests', async (t) => {
  const builds = [
    ['plugins {\n  alias(libs.plugins.android.application)\n  alias(libs.plugins.kotlin.android)\n}\n', 'kotlin-android'],
    ['plugins { alias(libs.plugins.androidLibrary) }\n', 'android-gradle'],
    ["apply plugin: 'com.android.application'\napply plugin: 'kotlin-android'\n", 'kotlin-android'],
    ["plugins {\n  id 'com.android.application'\n}\n", 'android-gradle'],
    ['plugins { id("com.android.library") }\n', 'android-gradle'],
    ['plugins {\n  alias(libs.plugins.android.application) apply false\n}\n', 'android-gradle']
  ];
  // [TCE:REQ-075] An Android module's unit tests run per variant; only Kotlin multiplatform needs a chosen target.
  for (const [build, stack] of builds) {
    assert.deepEqual(gradleBuildKind(build), { stack, requiresTestTarget: false, android: true }, build);
  }
  assert.deepEqual(gradleBuildKind('plugins { kotlin("multiplatform") }\n'), { stack: 'kotlin-multiplatform', requiresTestTarget: true, android: false });
  for (const [build, stack] of [
    ['plugins { java }\n', 'java-gradle'],
    ['dependencies { implementation("com.android.tools.build:gradle:8.5.0") }\n', 'java-gradle'],
    ['plugins { alias(libs.plugins.androidx.room) ; kotlin("jvm") }\n', 'kotlin-gradle']
  ]) {
    assert.deepEqual(gradleBuildKind(build), { stack, requiresTestTarget: false, android: false }, build);
  }
  assert.match(GRADLE_TEST_TARGET_REASON, /explicit test target/u);
  const root = await repository(t, { 'settings.gradle.kts': '', 'app/build.gradle.kts': builds[0][0] });
  assert.deepEqual((await inferModuleTestCommand(root, await resolveAffectedModule(root, 'app/src/main/Main.kt'))).argv, ['gradle', 'testDebugUnitTest']);
  await writeFile(path.join(root, 'app/build.gradle.kts'), `${builds[0][0]}android { productFlavors { create("free") {} } }\n`);
  await assert.rejects(inferModuleTestCommand(root, await resolveAffectedModule(root, 'app/src/main/Main.kt')),
    (error) => error.code === 'GRADLE_TEST_TARGET_REQUIRED' && error.details.root === 'app' && error.details.proposal.choices[0] === 'freeDebug');
});

test('a module without its own wrapper runs the nearest one above it, scoped to the module', async (t) => {
  const root = await repository(t, {
    mvnw: '#!/bin/sh\n', 'mvnw.cmd': '@echo off\n',
    'pom.xml': '<project><modules><!-- <module>legacy</module> --><module>services</module></modules></project>\n',
    'services/pom.xml': '<project><modules><module>./api/</module></modules></project>\n',
    'services/api/pom.xml': '<project/>\n',
    'samples/demo/pom.xml': '<project/>\n',
    gradlew: '#!/bin/sh\n', 'gradlew.bat': '@echo off\n', 'settings.gradle': "include ':lib:core'\n",
    'lib/core/build.gradle': 'plugins { java }\n'
  });
  const maven = await inferModuleTestCommand(root, { root: 'services/api', system: 'maven' }, { platform: 'darwin' });
  assert.deepEqual(maven.argv, ['./mvnw', '-pl', 'services/api', '-am', 'test']);
  assert.equal(maven.workingDirectory, '.');
  assert.deepEqual(maven.affectedRoots, ['services/api']);
  assert.equal(maven.result.path, 'services/api/target/surefire-reports');
  assert.equal((await inferModuleTestCommand(root, { root: 'services/api', system: 'maven' }, { platform: 'win32' })).argv[0], '.\\mvnw.cmd');
  // A POM the reactor does not declare runs the same wrapper from its own directory.
  const standalone = await inferModuleTestCommand(root, { root: 'samples/demo', system: 'maven' }, { platform: 'darwin' });
  assert.deepEqual(standalone.argv, ['../../mvnw', 'test']);
  assert.equal(standalone.workingDirectory, 'samples/demo');
  assert.equal(standalone.result.path, 'target/surefire-reports');
  assert.deepEqual((await inferModuleTestCommand(root, { root: 'samples/demo', system: 'maven' }, { platform: 'win32' })).argv,
    ['..\\..\\mvnw.cmd', 'test']);

  const gradle = await inferModuleTestCommand(root, { root: 'lib/core', system: 'gradle' }, { platform: 'darwin' });
  assert.deepEqual(gradle.argv, ['./gradlew', '-p', 'lib/core', 'test']);
  assert.equal(gradle.workingDirectory, '.');
  assert.deepEqual(gradle.affectedRoots, ['lib/core']);
  assert.equal(gradle.result.path, 'lib/core/build/test-results/test');
  assert.deepEqual((await inferModuleTestCommand(root, { root: 'lib/core', system: 'gradle' }, { platform: 'win32' })).argv,
    ['.\\gradlew.bat', '-p', 'lib/core', 'test']);
  // The root module still runs its own wrapper directly.
  assert.deepEqual((await inferModuleTestCommand(root, { root: '.', system: 'maven' }, { platform: 'darwin' })).argv, ['./mvnw', 'test']);

  const bare = await repository(t, { 'api/pom.xml': '<project/>\n' });
  assert.deepEqual((await inferModuleTestCommand(bare, { root: 'api', system: 'maven' }, { platform: 'darwin' })).argv, ['mvn', 'test']);
});
