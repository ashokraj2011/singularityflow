/** Reviewed optional semantic packs. Compiler artifacts remain separately installed. */
export const OPTIONAL_AST_SEMANTIC_PACKS = Object.freeze([
  Object.freeze({
    id: 'sflow-java-jdt', stage: 'semantic', languages: ['java'],
    projectKinds: ['maven', 'gradle', 'java-standalone'], platforms: ['win32', 'darwin', 'linux'],
    requiredToolchains: ['JDK', 'Eclipse JDT/JDT LS'], maturity: 'optional'
  }),
  Object.freeze({
    id: 'sflow-python-pyright', stage: 'semantic', languages: ['python'],
    projectKinds: ['python'], platforms: ['win32', 'darwin', 'linux'],
    requiredToolchains: ['Python interpreter/environment', 'Pyright'], maturity: 'optional'
  }),
  Object.freeze({
    id: 'sflow-kotlin-analysis', stage: 'semantic', languages: ['kotlin'],
    projectKinds: ['gradle', 'gradle-android'], platforms: ['win32', 'darwin', 'linux'],
    requiredToolchains: ['JDK', 'Kotlin Analysis API or approved IntelliJ host'], maturity: 'preview'
  }),
  Object.freeze({
    id: 'sflow-swift-sourcekit', stage: 'semantic', languages: ['swift'],
    projectKinds: ['swiftpm', 'xcode'], platforms: ['darwin', 'linux'],
    requiredToolchains: ['Swift toolchain', 'SourceKit-LSP', 'Xcode for iOS semantics'], maturity: 'optional'
  })
]);

export function optionalSemanticPack(id) {
  return OPTIONAL_AST_SEMANTIC_PACKS.find((pack) => pack.id === id) ?? null;
}
