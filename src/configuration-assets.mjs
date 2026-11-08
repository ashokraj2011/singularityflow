/** Compatibility asset names; native locations and kernel path rules have separate owners. */
export { CONFIGURATION_BRANCH, CONFIGURATION_SOURCE_PATH } from './configuration-read-scope.mjs';
export { portableFilesystemPathIdentity } from './foundation/portable-paths.mjs';
export { configurationAssetPolicy, mergeConfigurationAssetPolicies, DEFAULT_CONFIGURATION_ASSET_POLICY,
  portableConfigurationPath, isConfigurationAssetPath, configurationAssetSearchRoots } from './engine-compatibility/node-configuration-path.mjs';
