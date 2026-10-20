/**
 * Realistic IDE run configurations for the `app suggest` suites: JetBrains `.run`/`.idea` XML as
 * IntelliJ, PyCharm, WebStorm, GoLand and Rider write it, VS Code launch.json with comments and
 * trailing commas, .NET launchSettings.json, and platform markers. Every secret here is fake.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Fake secrets of every shape the reader must never copy. */
export const FAKE_SECRETS = Object.freeze({
  dbPassword: 'Fake-Db-Passw0rd-1729',
  jvmPassword: 'Jvm-Inline-Secret-4242',
  awsKey: 'AKIAIOSFODNN7EXAMPLE',
  awsSecret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.c2lnbmF0dXJlLWZha2UtMTIzNDU2Nzg5MA',
  urlPassword: 'pr1c1ngFakePw',
  djangoKey: 'django-insecure-fake-key-for-tests-only',
  highEntropy: 'Zk3q9Vb7Lp2Xw8Rt5Ny1Hc6Md4Gs0Jf',
  argumentToken: 'cli-token-value-31337',
  vscodeToken: 'vsc-fake-token-24601',
  launchSecret: 'Lnch-Fake-Secret-Profile-8080'
});

const xml = (configurations) => `<component name="ProjectRunConfigurationManager">\n${configurations}\n</component>\n`;
const envs = (pairs) => `    <envs>\n${Object.entries(pairs).map(([name, value]) => `      <env name="${name}" value="${value}" />`).join('\n')}\n    </envs>`;

export const SPRING_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.4</version></parent>
  <groupId>com.example.shop</groupId><artifactId>api</artifactId><version>1.0.0</version>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-actuator</artifactId></dependency>
  </dependencies>
  <build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build>
</project>
`;

export function springBootRun(name, profile, { password = FAKE_SECRETS.dbPassword } = {}) {
  return xml(`  <configuration default="false" name="${name}" type="SpringBootApplicationConfigurationType" factoryName="Spring Boot">
    <option name="ACTIVE_PROFILES" value="${profile}" />
    <module name="api" />
    <option name="SPRING_BOOT_MAIN_CLASS" value="com.example.shop.api.ApiApplication" />
    <option name="VM_PARAMETERS" value="-Xmx1g -Dspring.datasource.password=${FAKE_SECRETS.jvmPassword} -Dfile.encoding=UTF-8" />
    <option name="PROGRAM_PARAMETERS" value="--server.port=8081 --feature.flags=&quot;a b&quot;" />
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$/services/api" />
${envs({ DB_PASSWORD: password, SPRING_DATASOURCE_URL: 'jdbc:postgresql://localhost:5432/shop', AWS_ACCESS_KEY_ID: FAKE_SECRETS.awsKey,
    STORAGE_SIGNING: FAKE_SECRETS.awsSecret, CATALOG_URL: `http://127.0.0.1:9000/${profile}` })}
    <method v="2"><option name="Make" enabled="true" /></method>
  </configuration>`);
}

export const MAVEN_RUN = xml(`  <configuration default="false" name="api [spring-boot:run]" type="MavenRunConfiguration" factoryName="Maven">
    <MavenSettings>
      <option name="myGeneralSettings" />
      <option name="myRunnerSettings">
        <MavenRunnerSettings>
          <option name="delegateBuildToMaven" value="false" />
          <option name="environmentProperties">
            <map>
              <entry key="API_TOKEN" value="${FAKE_SECRETS.argumentToken}" />
              <entry key="LOG_LEVEL" value="debug" />
            </map>
          </option>
          <option name="jreName" value="#USE_PROJECT_JDK" />
          <option name="mavenProperties">
            <map><entry key="skipTests" value="true" /></map>
          </option>
          <option name="passParentEnv" value="true" />
          <option name="vmOptions" value="-Xmx512m" />
        </MavenRunnerSettings>
      </option>
      <option name="myRunnerParameters">
        <MavenRunnerParameters>
          <option name="cmdOptions" value="-q" />
          <option name="profiles"><set /></option>
          <option name="goals"><list><option value="spring-boot:run" /></list></option>
          <option name="pomFileName" value="pom.xml" />
          <option name="profilesMap"><map><entry key="local" value="true" /><entry key="ci" value="false" /></map></option>
          <option name="resolveToWorkspace" value="false" />
          <option name="workingDirPath" value="$PROJECT_DIR$/services/api" />
        </MavenRunnerParameters>
      </option>
    </MavenSettings>
    <method v="2" />
  </configuration>`);

export const GRADLE_RUN = xml(`  <configuration default="false" name="web [bootRun]" type="GradleRunConfiguration" factoryName="Gradle">
    <ExternalSystemSettings>
      <option name="env"><map><entry key="SPRING_PROFILES_ACTIVE" value="local" /></map></option>
      <option name="executionName" />
      <option name="externalProjectPath" value="$PROJECT_DIR$/services/web" />
      <option name="externalSystemIdString" value="GRADLE" />
      <option name="scriptParameters" value="--args='--server.port=8082' --debug-jvm" />
      <option name="taskDescriptions"><list /></option>
      <option name="taskNames"><list><option value="bootRun" /></list></option>
      <option name="vmOptions" />
    </ExternalSystemSettings>
    <ExternalSystemDebugServerProcess>true</ExternalSystemDebugServerProcess>
    <ExternalSystemReattachDebugProcess>true</ExternalSystemReattachDebugProcess>
    <DebugAllEnabled>false</DebugAllEnabled>
    <method v="2" />
  </configuration>`);

export const APPLICATION_RUN = xml(`  <configuration default="false" name="Worker" type="Application" factoryName="Application">
    <option name="MAIN_CLASS_NAME" value="com.example.shop.worker.Main" />
    <module name="worker.main" />
    <option name="PROGRAM_PARAMETERS" value="--queue orders" />
    <option name="VM_PARAMETERS" value="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005" />
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$" />
    <method v="2"><option name="Make" enabled="true" /></method>
  </configuration>`);

export const PYCHARM_UVICORN = xml(`  <configuration default="false" name="Pricing (dev)" type="PythonConfigurationType" factoryName="Python">
    <module name="pricing" />
    <option name="ENV_FILES" value="$PROJECT_DIR$/services/pricing/.env" />
    <option name="INTERPRETER_OPTIONS" value="" />
    <option name="PARENT_ENVS" value="true" />
${envs({ PYTHONUNBUFFERED: '1', DATABASE_URL: `postgresql://pricing:${FAKE_SECRETS.urlPassword}@localhost:5432/pricing`, PRICING_MODE: 'dev' })}
    <option name="SDK_HOME" value="$PROJECT_DIR$/.venv/bin/python" />
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$/services/pricing" />
    <option name="IS_MODULE_SDK" value="false" />
    <option name="ADD_CONTENT_ROOTS" value="true" />
    <option name="ADD_SOURCE_ROOTS" value="true" />
    <option name="SCRIPT_NAME" value="uvicorn" />
    <option name="PARAMETERS" value="app.main:app --reload --host 0.0.0.0 --port 8000" />
    <option name="SHOW_COMMAND_LINE" value="false" />
    <option name="EMULATE_TERMINAL" value="false" />
    <option name="MODULE_MODE" value="true" />
    <option name="REDIRECT_INPUT" value="false" />
    <option name="INPUT_FILE" value="" />
    <method v="2" />
  </configuration>`);

export const PYCHARM_DJANGO = xml(`  <configuration default="false" name="Back office" type="Python.DjangoServer" factoryName="Django server">
    <module name="backoffice" />
    <option name="INTERPRETER_OPTIONS" value="" />
    <option name="PARENT_ENVS" value="true" />
${envs({ PYTHONUNBUFFERED: '1', DJANGO_SETTINGS_MODULE: 'backoffice.settings.local', SECRET_KEY: FAKE_SECRETS.djangoKey })}
    <option name="SDK_HOME" value="/Users/someone/.pyenv/versions/3.12.4/bin/python" />
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$/services/backoffice" />
    <option name="IS_MODULE_SDK" value="false" />
    <option name="ADD_CONTENT_ROOTS" value="true" />
    <option name="ADD_SOURCE_ROOTS" value="true" />
    <option name="launchJavascriptDebuger" value="false" />
    <option name="port" value="8001" />
    <option name="host" value="0.0.0.0" />
    <option name="additionalOptions" value="" />
    <option name="browserUrl" value="" />
    <option name="runTestServer" value="false" />
    <option name="runNoReload" value="false" />
    <option name="useCustomRunCommand" value="false" />
    <option name="customRunCommand" value="" />
    <method v="2" />
  </configuration>`);

export const PYCHARM_SCRIPT = xml(`  <configuration default="false" name="Nightly report" type="PythonConfigurationType" factoryName="Python">
    <option name="INTERPRETER_OPTIONS" value="-X dev" />
    <option name="SDK_HOME" value="" />
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$" />
    <option name="SCRIPT_NAME" value="$PROJECT_DIR$/tools/report.py" />
    <option name="PARAMETERS" value="--out $PROJECT_DIR$/build/report --token ${FAKE_SECRETS.argumentToken}" />
    <option name="MODULE_MODE" value="false" />
    <method v="2" />
  </configuration>`);

export const WEBSTORM_NODE = xml(`  <configuration default="false" name="Gateway" type="NodeJSConfigurationType" path-to-node="project" node-parameters="--enable-source-maps --inspect=9230" path-to-js-file="src/server.js" application-parameters="--port 4000" working-dir="$PROJECT_DIR$/services/gateway">
${envs({ GATEWAY_SESSION: FAKE_SECRETS.jwt, NODE_ENV: 'development', UPSTREAM_URL: 'http://127.0.0.1:8081/' })}
    <method v="2" />
  </configuration>`);

export const WEBSTORM_NPM = xml(`  <configuration default="false" name="storefront dev" type="js.build_tools.npm" factoryName="npm">
    <package-json value="$PROJECT_DIR$/apps/storefront/package.json" />
    <command value="run" />
    <scripts>
      <script value="dev" />
    </scripts>
    <arguments value="-- --port 5174" />
    <node-interpreter value="project" />
${envs({ VITE_API_URL: 'http://127.0.0.1:8081/api' })}
    <method v="2" />
  </configuration>`);

export const GOLAND_RUN = xml(`  <configuration default="false" name="inventory" type="GoApplicationRunConfiguration" factoryName="Go Application">
    <module name="inventory" />
    <working_directory value="$PROJECT_DIR$/services/inventory" />
    <go_parameters value="-race" />
    <parameters value="-addr :9091" />
${envs({ INVENTORY_DB_URL: 'postgres://inventory@localhost:5432/inventory', CACHE_TTL: '30s' })}
    <kind value="DIRECTORY" />
    <package value="example.com/shop/inventory/cmd/inventory" />
    <directory value="$PROJECT_DIR$/services/inventory/cmd/inventory" />
    <filePath value="$PROJECT_DIR$/services/inventory/cmd/inventory/main.go" />
    <method v="2" />
  </configuration>`);

export const RIDER_RUN = xml(`  <configuration default="false" name="Billing: http" type="LaunchSettings" factoryName=".NET Launch Settings Profile">
    <option name="LAUNCH_PROFILE_PROJECT_FILE_PATH" value="$PROJECT_DIR$/services/billing/Billing.csproj" />
    <option name="LAUNCH_PROFILE_TFM" value="net8.0" />
    <option name="LAUNCH_PROFILE_NAME" value="http" />
    <option name="USE_EXTERNAL_CONSOLE" value="0" />
    <option name="USE_MONO" value="0" />
    <option name="RUNTIME_ARGUMENTS" value="" />
    <option name="GENERATE_APPLICATIONHOST_CONFIG" value="1" />
    <option name="SHOW_IIS_EXPRESS_OUTPUT" value="0" />
    <option name="SEND_DEBUG_REQUEST" value="1" />
    <option name="ADDITIONAL_IIS_EXPRESS_ARGUMENTS" value="" />
    <method v="2"><option name="Build" /></method>
  </configuration>`);

export const LAUNCH_SETTINGS = `{
  "$schema": "http://json.schemastore.org/launchsettings.json",
  "iisSettings": { "windowsAuthentication": false, "anonymousAuthentication": true,
    "iisExpress": { "applicationUrl": "http://localhost:24545", "sslPort": 44300 } },
  "profiles": {
    "http": {
      "commandName": "Project",
      "dotnetRunMessages": true,
      "launchBrowser": true,
      "applicationUrl": "http://localhost:5080",
      "environmentVariables": { "ASPNETCORE_ENVIRONMENT": "Development", "Billing__ApiSecret": "${FAKE_SECRETS.launchSecret}" }
    },
    "https": {
      "commandName": "Project",
      "applicationUrl": "https://localhost:7080;http://localhost:5080",
      "environmentVariables": { "ASPNETCORE_ENVIRONMENT": "Development", "BILLING_API_SECRET": "${FAKE_SECRETS.launchSecret}" }
    },
    "IIS Express": { "commandName": "IISExpress", "launchBrowser": true, "environmentVariables": { "ASPNETCORE_ENVIRONMENT": "Development" } }
  }
}
`;

export const VSCODE_LAUNCH = `{
  // Use IntelliSense to learn about possible attributes.
  "version": "0.2.0",
  "configurations": [
    {
      "type": "java",
      "name": "Catalog (qa)",
      "request": "launch",
      "mainClass": "com.example.shop.catalog.CatalogApplication",
      "projectName": "catalog",
      "cwd": "\${workspaceFolder}/services/catalog",
      "vmArgs": "-Dspring.profiles.active=qa",
      "args": ["--server.port=8083"],
      "env": { "CATALOG_TOKEN": "${FAKE_SECRETS.vscodeToken}", "CATALOG_REGION": "eu-west-1" },
    },
    /* FastAPI under debugpy */
    {
      "name": "Search API",
      "type": "debugpy",
      "request": "launch",
      "module": "uvicorn",
      "args": ["search.main:app", "--port", "8010"],
      "cwd": "\${workspaceFolder}/services/search",
      "envFile": "\${workspaceFolder}/services/search/.env",
      "jinja": true,
    },
    {
      "name": "Notifier",
      "type": "pwa-node",
      "request": "launch",
      "program": "\${workspaceFolder}/services/notifier/index.js",
      "args": ["--port", "4100"],
      "env": { "SMTP_PASSWORD": "\${env:SMTP_PASSWORD}", "NOTIFY_FROM": "shop@example.test" }
    },
    {
      "name": "Admin UI (npm)",
      "type": "node",
      "request": "launch",
      "cwd": "\${workspaceFolder}/apps/admin-ui",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run-script", "dev"],
    },
    {
      "name": "Shipping",
      "type": "go",
      "request": "launch",
      "mode": "auto",
      "program": "\${workspaceFolder}/services/shipping",
      "buildFlags": "-tags dev",
      "args": ["--port", "9092"],
    },
    {
      "name": ".NET Core Launch (web)",
      "type": "coreclr",
      "request": "launch",
      "preLaunchTask": "build",
      "program": "\${workspaceFolder}/services/billing/bin/Debug/net8.0/Billing.dll",
      "args": [],
      "cwd": "\${workspaceFolder}/services/billing",
      "env": { "ASPNETCORE_URLS": "http://localhost:5090" }
    },
    { "name": "Attach to Node", "type": "node", "request": "attach", "port": 9229 },
    { "name": "Outside", "type": "node", "request": "launch", "program": "\${workspaceFolder}/../outside/index.js" },
    { "name": "Home", "type": "node", "request": "launch", "program": "\${userHome}/tools/index.js" },
  ],
}
`;

async function put(root, relative, content) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), content);
}

/** A repository with every kind of configuration `app suggest` reads, committed. */
export async function ideRepository(t, { environments = ['dev', 'qa'], extra = {}, capability = {} } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-ide-'));
  t.after(async () => (await import('node:fs/promises')).rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'shop');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  await mkdir(root, { recursive: true });
  git('init', '-q');
  const files = {
    'singularity/capabilities.yml': `version: 1\ncapabilities:\n  shop:\n    kind: delivery\n    repository: shop\n${capability.yaml ?? ''}`,
    ...(environments ? { 'singularity/environments.yml': `schemaVersion: 1\nenvironments:\n${environments.map((name) => `  ${name}:\n    requires:\n      - { name: SHOP_REGION, kind: flag, default: eu }\n`).join('')}` } : {}),
    'mvnw': '#!/bin/sh\nexec mvn "$@"\n',
    'mvnw.cmd': '@echo off\r\nmvn %*\r\n',
    'services/api/pom.xml': SPRING_POM,
    'services/api/src/main/resources/application.properties': 'server.port=8081\nspring.application.name=api\n',
    'services/web/build.gradle.kts': 'plugins {\n  id("org.springframework.boot") version "3.3.4"\n  java\n}\n',
    'services/web/gradlew': '#!/bin/sh\n',
    'services/web/gradlew.bat': '@echo off\r\n',
    'worker/build.gradle': 'plugins { id \'application\' }\napplication { mainClass = \'com.example.shop.worker.Main\' }\n',
    'services/pricing/app/__init__.py': '',
    'services/pricing/app/main.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n',
    '.venv/bin/python': '#!/bin/sh\n',
    'services/backoffice/manage.py': '#!/usr/bin/env python\nimport os, sys\n',
    'tools/report.py': 'print("report")\n',
    'services/gateway/src/server.js': 'console.log("gateway")\n',
    'apps/storefront/package.json': JSON.stringify({ name: 'storefront', private: true, scripts: { dev: 'vite', build: 'vite build' } }, null, 2),
    'apps/admin-ui/package.json': JSON.stringify({ name: 'admin-ui', private: true, scripts: { dev: 'vite --port 5175' } }, null, 2),
    'services/inventory/go.mod': 'module example.com/shop/inventory\n\ngo 1.22\n',
    'services/inventory/cmd/inventory/main.go': 'package main\n\nfunc main() {}\n',
    'services/shipping/go.mod': 'module example.com/shop/shipping\n\ngo 1.22\n',
    'services/shipping/main.go': 'package main\n\nfunc main() {}\n',
    'services/billing/Billing.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n',
    'services/billing/Properties/launchSettings.json': LAUNCH_SETTINGS,
    'services/catalog/pom.xml': SPRING_POM.replace('<artifactId>api</artifactId>', '<artifactId>catalog</artifactId>'),
    'services/search/search/__init__.py': '',
    'services/search/search/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    'services/notifier/index.js': 'console.log("notifier")\n',
    '.run/Api (dev).run.xml': springBootRun('Api (dev)', 'dev'),
    '.run/Api (qa).run.xml': springBootRun('Api (qa)', 'qa'),
    '.run/api [spring-boot_run].run.xml': MAVEN_RUN,
    '.run/web [bootRun].run.xml': GRADLE_RUN,
    '.idea/runConfigurations/Worker.xml': APPLICATION_RUN,
    '.run/Pricing (dev).run.xml': PYCHARM_UVICORN,
    '.idea/runConfigurations/Back_office.xml': PYCHARM_DJANGO,
    '.run/Nightly report.run.xml': PYCHARM_SCRIPT,
    '.run/Gateway.run.xml': WEBSTORM_NODE,
    '.run/storefront dev.run.xml': WEBSTORM_NPM,
    '.run/inventory.run.xml': GOLAND_RUN,
    '.run/Billing.run.xml': RIDER_RUN,
    '.vscode/launch.json': VSCODE_LAUNCH,
    ...extra
  };
  for (const [relative, content] of Object.entries(files)) await put(root, relative, content);
  git('add', '-A');
  git('-c', 'user.name=Suggest Tester', '-c', 'user.email=suggest-tester@example.invalid', 'commit', '-qm', 'fixture');
  return { base, root, git, put: (relative, content) => put(root, relative, content) };
}
