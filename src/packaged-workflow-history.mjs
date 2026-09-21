import { createHash } from 'node:crypto';

/**
 * Canonical hashes of framework-owned workflow nodes from released configuration schemas.
 *
 * A legacy repository may predate the durable ownership receipt. Exact registered values are
 * still safe framework provenance; a one-field repository customization produces a different
 * hash and remains repository-owned. Keep this registry node-scoped so adding a custom workflow
 * never prevents genuine historical seeds beside it from upgrading.
 */
const HISTORICAL_PACKAGED_WORKFLOW_VALUE_SHA256 = Object.freeze({
  workTypes: Object.freeze({
    feature: Object.freeze(['ede8edc40a1344342e8668202f33fd0beee614cf30064154f2b6c2c681ffab63']),
    bugfix: Object.freeze(['3ac82069488a0728421c7c86d9a47b29b13bed568be47a8c67fab7c75a0287c3']),
    chore: Object.freeze(['327de2a67c41d50bccc308a5925c2025f19efb170e1a4f1aa20cec5df9f63c67']),
    'figma-mobile': Object.freeze(['d165709b28aa97f2a2d4416d19cf7cdde14bb9fa0f1632b30733ff4e2c266e52']),
    // Modern v2 predecessor immediately before the guarded REV pilot was added.
    'classic-delivery': Object.freeze([
      '8334062f0d4d0e5295d3ba1e3ccc64bef8901d3cdbccdb2ab880cd33fed20111'
    ])
  }),
  phases: Object.freeze({
    intake: Object.freeze(['f8d4857dff76ed804794c43496adc841113bb89e13a2ae6a28182396777cc8ac']),
    requirements: Object.freeze(['2d6d5be32c33763f982421fb4072040f6ef8f94d8310afb69c5787fe3c72b0fc']),
    design: Object.freeze(['07de52089a44ac8a5716ea916cd879d71c1fc60298058c85ad66bee1698a0877']),
    'implementation-spec': Object.freeze(['10fd283a42cffb449fa1c31c3d0feedc713cdcef6286c16b56d50aec407a3dca']),
    reproduction: Object.freeze(['cb404fb39200c909784cdc079818dbac7c34a3c06c0c2630d2256e6c492bac60']),
    'fix-design': Object.freeze(['49ce60f68b88deef9b910986f10d18db062f44789931966793aa71835908335e']),
    'fix-spec': Object.freeze(['05f34619ab79a6120d58263eb68d486e51007d7e8e6ecd95caaf6723dff3b9a8']),
    'design-intake': Object.freeze(['8d4ea22f7de43c62327e15dfcb1d37b99dcc4365c96df5e6b68db8bb46b4ac37']),
    'design-inventory': Object.freeze(['e5d6cf67658f350b900f5eb6fcfcc7bab0a286da2184e0aa100aa801dd70c20f']),
    'component-mapping': Object.freeze(['7e23844a21b566e3c79568613659157586f210826a930e1176950b2f5c85ddd0']),
    'mobile-spec': Object.freeze(['9b3a14f1f8cbe29965845546967a3122dc560b17419b395628749a1df874da4e']),
    implementation: Object.freeze(['36d1474a044734c2a03ddb3295b152b282159f693807dda91786022e0d91a7e2']),
    verification: Object.freeze(['9c15223a3f11cf23bf94000c089dc47d87b63cf2c2a44d2e56a783fd32907493']),
    'visual-verification': Object.freeze(['472d021acf80e259457dfa19fa80f3fd93e08f998c74d99c2600d0ba37444aed']),
    conformance: Object.freeze(['9874a43a4d9784e22ae068855061f2fda85cd46ceb4c3a2602acb339caecf44c']),
    // Modern v2 predecessor before explicit clarification-off policy was added.
    planning: Object.freeze([
      '91c8f6571cd05fafac5e28c225e5f08009d27b59ee14be776de7ffff8d4632e9'
    ])
  }),
  artifactSets: Object.freeze({
    // Reviewed predecessor where the requirements checklist was still mandatory.
    'spec-driven-specification': Object.freeze([
      '82c85b1e5379092dba836bf867b23a32cb00c1a59de1778e43bf6a655b84e59f'
    ])
  }),
  mcpServers: Object.freeze({
    // Reviewed predecessor before browser evidence was enabled for the Testing phase.
    playwright: Object.freeze([
      'dc0952904a8d2944f3e66dd72eddd4e47c0f8827b98325b0f7f00734602b8ee1'
    ])
  })
});

/** Exact canonical hashes for every workflow node shipped by this package release. */
export const CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256 = Object.freeze({
  workTypes: Object.freeze({
    'benchmarking-a': '0a18e2ce95010eee32b209c98e1e9ab9d3a9993e78ca10f23938b2d3fe3d13cd',
    'benchmarking-b': 'aa433bacbaead95204b96700360598b5e2e1c682ac1a5846d6fa415adf1b5548',
    bugfix: 'c1f0c3bf9e28757f0a60dea93412dd258890d73b82802227a825ada21bce4ef4',
    chore: 'c5ffa49fee9721d9fb1e7c55d800cbd13b7d045dcdde800fbd42fb085986139c',
    'classic-delivery': '98cc169510f82d9e046df5471975cf354b7afb7d1acacd0ef0c91b5c51d4f039',
    feature: '07788c17b175c7cd6abe11d719022fa041c28f28227d3e01664c3aee3c61ae8a',
    'figma-mobile': '145c68b32584aea0b8b6332db9558c5f06b3cb85e346d737a57c8b7e5f07c6ee',
    'poc-lite': '87eed6bd5881b47c0cab5316d96c7652b114f43863fb0ceed1f1615165f262f0',
    'poc-workflow': 'dc72ed2683f76ed9c561ffe0135b442e8eb88202a661ea39031545d29a965d75',
    'quick-fix': '6ee5ad86a29a3805d914552eed7d0b5d049abb8044ea98365df10dd3fd5cbcc3',
    'reference-driven-build': 'ee3b8742aaadf5fcc04735833a3db98431b34fd11231d3caa50279e8eb3eed74',
    'spec-code-test-loop': 'f6a911e589320f8fd63b4933c61b2656068c9757d55267e60f2e47c6e5259e3b',
    'spec-driven-standard': '3f354e9fe3bf1de8bf2c5c2c1e4e135e9bf5ecbc13d34b2e8514000f784d03ce'
  }),
  phases: Object.freeze({
    'component-mapping': '35e812770061284af78d1c9bac956ced7f331ca184cb4bea7f3ca04d7f9c95eb',
    conformance: 'dca6d2516087e3b6dd590cf298c6213ab71a875f6c891f0f815959a50ab04fb2',
    convergence: 'd34e5232cf52c5adca8f5a23648a9ea5fd77e4e29f24c858c658c3e495ebf121',
    design: 'f7ee1f2db131d69f8b8bdca489722ec0142daee15e7bcab4cd2e69e1d2b6ab32',
    'design-intake': 'c627e7856b5c077ac9b6f2395623d0ab440ab9ad02a2a2f983679830968719e1',
    'design-inventory': 'abd5671883bb6f98ea452790bfdc05b56d826d667055fbe24d9f7a61405a2d3c',
    'fix-design': '738a2da6b1a6777785f500055715c2474ab9ebc20904d120e3f864916a61ecfe',
    'fix-spec': '6716d50536dccfa1ca58e5f85e4ce9a21f1c95d183397546645bb6156074768d',
    implement: '23a79bed9ddd4b5e9ac014dc70385a673ed32c7650b6859ad90d2fefe71a3705',
    implementation: 'ac65a5896a978d4bb4fafacb3e88770f63d548dc736608a0872ef80b2a42d0dc',
    'implementation-spec': 'b7c27b6097c2528a43e6b7b3ca46abee330616dbc38446117568d4b4fa887a98',
    intake: '9fc6c2cd2343e20f069ff01dbefadcba65584f1d29ed21a74a7ef4899bf89629',
    'mobile-spec': 'ca57cd0f5fe383e0f86eb1fcfc30feb18bb0454ef42d17a1eda8ae59565759a0',
    planning: '54909eadadd1b11f1db764daf5ae3d91748f64b4c4562b631ff76397adc7e2f1',
    'poc-impact-analysis': '2373b60e36c6e9dea243ea23da8c72a4fd9350520aa3216fc35db2f7ea05cda3',
    'poc-intake': '76811191e717df47e168692e756258fcabc7ef9ce041b5da4ab48549509fec98',
    'poc-lite-act': 'b28f65c1adddecccf497b6bfd54e9f0403d731ed702dfe7c465607660878b24d',
    'poc-lite-finalize': '394eb36ea92586141e72344326e9451361feeaa1c470bcb5d35829878ed9111a',
    'poc-lite-plan': '84c10512fee313c3cf749c8955d61ed4b8cfa1508ff9771e6408c7228345b1f5',
    'poc-lite-verify': '576f07dfd8faf2bda181ce81962c3ed5b7155e46b6ad2a02dbd75f505374210b',
    'poc-publication-review': 'af1a2462810e87ce834abe2156ff28985a9ae25b1def62b8367f2182806d7231',
    'poc-test-generation': '30e4071d25e552e602a16ee9f97c487c48fa343ca98a7788b68a8b59c6cfc062',
    'poc-ui-exploration': '3fde897460ee03d86cb101f528767b9084e51c4e4bd265d0fbc9fff77a624a74',
    'poc-validation': 'cfea9285e450eb20fd1ad3435da334beb56646612fa38bd33e5dcf73d4803384',
    release: 'ea1d875e603e54c8621eacf8c0e23fa2d2c20d2b9358c479b4eec6c2731f1d2a',
    reproduction: '493668d016cd6d280c31011fcccfad2017b2931a8bd5871acaccf561efc1063b',
    requirements: '360a64821e529395e9ba85bf6d80270ca16562323f7fa535494c6719616d44b1',
    specification: '11ef5fa9479175bd8e27d5a07af58a74471473fe8322116ba6dd7e93d5ccb527',
    testing: '4ecef918781975e253ea4b85baeb635a15966f9eb9b24c68815ba1cb54e18e09',
    verification: 'b76ea4b72e122af77b6c2b42492a929d99fb927cb8cf8d23407dc429e372ea42',
    verify: 'b223f79a5b01215f4dff056c33711c0bc96fde20d9ec6fa8f8c88c6dd5e12875',
    'visual-verification': 'c5d6cce09178cb6780dd21dd61dd642b44da5c5bc214e5bdb81bef7241d36453'
  }),
  artifactSets: Object.freeze({
    'spec-driven-planning': 'bc18e7338a3819b75a65ed001f0cd7843f3be8c9b3908db769a6578d97f44d12',
    'spec-driven-specification': '25addecf58a557501a48e80e006657dad96e99ea6c916d76d07b96946dd66449',
    'spec-driven-verification': '1cf89e7a577eab988518048b20f540f115227f6fc98e275a9e26be52dcc9f3ff'
  }),
  mcpServers: Object.freeze({
    figma: '30ef371d29021a7f50a1c5bda73f022c727998a6ae99fd57a3e51335ccaad9fb',
    playwright: 'd5dcb613feed5a69dda1123ac922435fa130bc8e7cd9ab6845726c420c0757cc'
  })
});

/** Every exact released workflow-node revision accepted as framework provenance. */
export const KNOWN_PACKAGED_WORKFLOW_VALUE_SHA256 = Object.freeze(Object.fromEntries(
  ['workTypes', 'phases', 'artifactSets', 'mcpServers'].map((section) => [
    section,
    Object.freeze(Object.fromEntries(
      [...new Set([
        ...Object.keys(HISTORICAL_PACKAGED_WORKFLOW_VALUE_SHA256[section] ?? {}),
        ...Object.keys(CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256[section] ?? {})
      ])].sort().map((id) => [id, Object.freeze([
        ...new Set([
          ...(HISTORICAL_PACKAGED_WORKFLOW_VALUE_SHA256[section]?.[id] ?? []),
          ...(CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256[section]?.[id]
            ? [CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256[section][id]] : [])
        ])
      ])])
    ))
  ])
));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function packagedWorkflowValueSha256(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function isKnownPackagedWorkflowValue(section, id, value) {
  const registered = KNOWN_PACKAGED_WORKFLOW_VALUE_SHA256[section]?.[id];
  if (!registered || value === undefined) return false;
  return registered.includes(packagedWorkflowValueSha256(value));
}
