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
    feature: Object.freeze([
      'ede8edc40a1344342e8668202f33fd0beee614cf30064154f2b6c2c681ffab63',
      '07788c17b175c7cd6abe11d719022fa041c28f28227d3e01664c3aee3c61ae8a',
      // Before broader return routes (2026-10-12).
      'f69c7d96643df7084e58aa5eb6692a703be004d21d31d06942dbb9a6962a25d3',
      // Before approve twice: steps other than the plan and those that may change source files approved automatically when ready (2026-11-19).
      '7a7103892a8196fc57254ab39442e2b090492bf9bbeaa01e16873d1c00e151d3'
    ]),
    bugfix: Object.freeze([
      '3ac82069488a0728421c7c86d9a47b29b13bed568be47a8c67fab7c75a0287c3',
      'c1f0c3bf9e28757f0a60dea93412dd258890d73b82802227a825ada21bce4ef4',
      // Before broader return routes (2026-10-12).
      '39ac9d457a906eeeae595d44fa379b709c4ecb77f2992b30d54b327c1312fc24',
      // Before approve twice: steps other than the plan and those that may change source files approved automatically when ready (2026-11-19).
      '3e763732474cf68c7d25b0f889f87f8f901004265f9b06b5dd116b2540d4da5f'
    ]),
    chore: Object.freeze([
      '327de2a67c41d50bccc308a5925c2025f19efb170e1a4f1aa20cec5df9f63c67',
      'c5ffa49fee9721d9fb1e7c55d800cbd13b7d045dcdde800fbd42fb085986139c',
      // Before the chore intake became its scope-and-plan checkpoint.
      'bbb46f247a676e737505f28c6b06638dddbf47108d324ea6c4b15d97632aa9ba',
      // Before broader return routes (2026-10-12).
      '7d55217aa976c51a702616daeccd8829ca91778839985ae8c4dabc3336645597',
      // Before approve twice: steps other than the plan and those that may change source files approved automatically when ready (2026-11-19).
      '749198a9f0d3678e05476ef857fecfc1886fba47d2ceb9e037927e5752f67120'
    ]),
    // Before quick-fix gained its scope-and-plan intake and POC Lite replaced its planned-claim
    // opt-out with a declared scope omission.
    'quick-fix': Object.freeze(['6ee5ad86a29a3805d914552eed7d0b5d049abb8044ea98365df10dd3fd5cbcc3']),
    'poc-lite': Object.freeze(['87eed6bd5881b47c0cab5316d96c7652b114f43863fb0ceed1f1615165f262f0']),
    'figma-mobile': Object.freeze([
      'd165709b28aa97f2a2d4416d19cf7cdde14bb9fa0f1632b30733ff4e2c266e52',
      // Before broader return routes (2026-10-12).
      '145c68b32584aea0b8b6332db9558c5f06b3cb85e346d737a57c8b7e5f07c6ee',
      // Before approve twice: steps other than the plan and those that may change source files approved automatically when ready (2026-11-19).
      '183fab75a69bc986f9c1a3f9a8aa55884396366f22ca4d367f66e9d933feec63'
    ]),
    // Modern v2 predecessor immediately before the guarded REV pilot was added.
    'classic-delivery': Object.freeze([
      '8334062f0d4d0e5295d3ba1e3ccc64bef8901d3cdbccdb2ab880cd33fed20111',
      // Before broader return routes (2026-10-12).
      '98cc169510f82d9e046df5471975cf354b7afb7d1acacd0ef0c91b5c51d4f039',
      // Before approve twice: steps other than the plan and those that may change source files approved automatically when ready (2026-11-19).
      'fc15e98913f4c0cbe6941b0005bd397c36812308d53ffd9cf3e0c04ec9a9ee6f'
    ]),
    // Previous spec-driven starter preserved only three specification headings in downstream
    // briefs and left implementation clause coverage advisory. The second revision took no
    // supporting documents after Story start.
    'spec-driven-standard': Object.freeze([
      '3f354e9fe3bf1de8bf2c5c2c1e4e135e9bf5ecbc13d34b2e8514000f784d03ce',
      'cf9cda3f0927f3b32fbfd585e5c2c7bedd9f6e7d0821bfbe7a0bf6d0e46d2461',
      // Before broader return routes (2026-10-12).
      '6528062cd8e1ce663f60ebf361720562f778a03bc808e52158de07bb6cabeacf',
      // Before approve twice: steps other than the plan and those that may change source files approved automatically when ready (2026-11-19).
      'c4006042d4bc9388096e5a71da3d1831ab4ef2cbbf123a6fd0612300549ff30e'
    ]),
    // Took no supporting documents after Story start.
    'reference-driven-build': Object.freeze([
      'ee3b8742aaadf5fcc04735833a3db98431b34fd11231d3caa50279e8eb3eed74',
      // Before broader return routes (2026-10-12).
      'a577515ed38c8f6d12c82890cc7076ac3ddf06d22370028d3e52c3f911acbc71',
      // Before approve twice: steps other than the plan and those that may change source files approved automatically when ready (2026-11-19).
      'b786e7026caae3a2a41130bd55b97f656de6e3c0c0a2e3390963532f996f9b62'
    ]),
    // Before its phase overrides stopped naming (empty) World Model views.
    'benchmarking-b': Object.freeze([
      'aa433bacbaead95204b96700360598b5e2e1c682ac1a5846d6fa415adf1b5548',
      // Before broader return routes (2026-10-12).
      '22b76b63947822eff26a76c5b360c132cfb24e81ee4f6975201511ea19669363'
    ]),
    // Before broader return routes (2026-10-12).
    'benchmarking-a': Object.freeze(['0a18e2ce95010eee32b209c98e1e9ab9d3a9993e78ca10f23938b2d3fe3d13cd']),
    // Before its description said its validation gates run TypeScript Playwright through npm.
    'poc-workflow': Object.freeze(['dc72ed2683f76ed9c561ffe0135b442e8eb88202a661ea39031545d29a965d75']),
    // Before approve twice (2026-11-19).
    'findings-remediation': Object.freeze(['34e975e5c19105aba55707169ec1cc8ab75d9db7601d9d062741a81b458c0499']),
    // Before approve twice (2026-11-19).
    'spec-code-test-loop': Object.freeze(['f6a911e589320f8fd63b4933c61b2656068c9757d55267e60f2e47c6e5259e3b'])
  }),
  phases: Object.freeze({
    testing: Object.freeze([
      // Native v4 assignments supersede these exact packaged legacy revisions.
      '4ecef918781975e253ea4b85baeb635a15966f9eb9b24c68815ba1cb54e18e09',
      // Before repositoryTests: run (2026-10-23).
      '3953d7c4c106cfdde9ce7654b93b718e36cbf57618b06f4c417bdd3f6a1867c9'
    ]),
    'poc-intake': Object.freeze(['76811191e717df47e168692e756258fcabc7ef9ce041b5da4ab48549509fec98']),
    'poc-impact-analysis': Object.freeze(['2373b60e36c6e9dea243ea23da8c72a4fd9350520aa3216fc35db2f7ea05cda3']),
    'poc-ui-exploration': Object.freeze([
      '3fde897460ee03d86cb101f528767b9084e51c4e4bd265d0fbc9fff77a624a74',
      // Before broader return routes (2026-10-12).
      'c93727af1010872a188ee6c38a36d71e77ef3b1700a54a79525e7c8999cc15ee'
    ]),
    'poc-test-generation': Object.freeze([
      '30e4071d25e552e602a16ee9f97c487c48fa343ca98a7788b68a8b59c6cfc062',
      // Before broader return routes (2026-10-12).
      '5f60847e67d8b1b9b5c4b834d38f618b9c9da38c57d61ea1802f1a25a272810b'
    ]),
    'poc-validation': Object.freeze([
      'cfea9285e450eb20fd1ad3435da334beb56646612fa38bd33e5dcf73d4803384',
      // Before broader return routes (2026-10-12).
      '335f9997bf3741ce5037cdf683def71d2f70337c6e5f1b9f4d2453713fcd088c'
    ]),
    'poc-publication-review': Object.freeze(['af1a2462810e87ce834abe2156ff28985a9ae25b1def62b8367f2182806d7231']),
    release: Object.freeze([
      'ea1d875e603e54c8621eacf8c0e23fa2d2c20d2b9358c479b4eec6c2731f1d2a',
      // Before broader return routes (2026-10-12).
      '43c9560ce805d8cd3de33a1abfd1415019afc11770a1c6fe54321de188fb0314'
    ]),
    implement: Object.freeze(['23a79bed9ddd4b5e9ac014dc70385a673ed32c7650b6859ad90d2fefe71a3705']),
    verify: Object.freeze([
      'b223f79a5b01215f4dff056c33711c0bc96fde20d9ec6fa8f8c88c6dd5e12875',
      // Before broader return routes (2026-10-12).
      'bd3aef3d29f9c0ce631ce533eabb905cee1a6ab20f52f8135b4aaf1b6cd6c3d4'
    ]),
    intake: Object.freeze(['9fc6c2cd2343e20f069ff01dbefadcba65584f1d29ed21a74a7ef4899bf89629', 'f8d4857dff76ed804794c43496adc841113bb89e13a2ae6a28182396777cc8ac']),
    requirements: Object.freeze(['360a64821e529395e9ba85bf6d80270ca16562323f7fa535494c6719616d44b1', '2d6d5be32c33763f982421fb4072040f6ef8f94d8310afb69c5787fe3c72b0fc', '77d4d3c86d39421019846caf252ae80b8242cfcb0e5c7886116164306715f973']),
    design: Object.freeze(['f7ee1f2db131d69f8b8bdca489722ec0142daee15e7bcab4cd2e69e1d2b6ab32', '07de52089a44ac8a5716ea916cd879d71c1fc60298058c85ad66bee1698a0877', 'cb2603200e89e62c719c5c31d031ee6234572b52f2b3dffae2317ff410b513a8']),
    'implementation-spec': Object.freeze([
      'b7c27b6097c2528a43e6b7b3ca46abee330616dbc38446117568d4b4fa887a98',
      '10fd283a42cffb449fa1c31c3d0feedc713cdcef6286c16b56d50aec407a3dca',
      // Before broader return routes (2026-10-12).
      '56f8cd7bd70d104ae689c952446b1ba54c188c25eda4a4f9de6d7a4cb2c49637',
      // Before clarification was required only at a Story's intake (2026-11-19).
      '18e7c92857df911b40df1635ff6edd882a247b9e9adbfd1183e83f188b0c122f'
    ]),
    reproduction: Object.freeze(['493668d016cd6d280c31011fcccfad2017b2931a8bd5871acaccf561efc1063b', 'cb404fb39200c909784cdc079818dbac7c34a3c06c0c2630d2256e6c492bac60', '16fa17c5cc2287afbf1fdb193e6f06f9fe643d504fcd0b19bdefa6ea56355bde']),
    'fix-design': Object.freeze([
      '738a2da6b1a6777785f500055715c2474ab9ebc20904d120e3f864916a61ecfe',
      '49ce60f68b88deef9b910986f10d18db062f44789931966793aa71835908335e',
      // Before broader return routes (2026-10-12).
      '1085cd2472104e4342ac0b13db4b44087004a7a6742bf15f63646806319ca93b',
      // Before clarification was required only at a Story's intake (2026-11-19).
      'e83731ee5e8c1514565cc3403edb3f47895bb44c94d599a802e648df321f0505'
    ]),
    'fix-spec': Object.freeze([
      '6716d50536dccfa1ca58e5f85e4ce9a21f1c95d183397546645bb6156074768d',
      '05f34619ab79a6120d58263eb68d486e51007d7e8e6ecd95caaf6723dff3b9a8',
      // Before broader return routes (2026-10-12).
      'ae226973c098930cff207afd51f304f466272abdb0d6c428eac562279ec062f1',
      // Before clarification was required only at a Story's intake (2026-11-19).
      '9e87a5dd8747c5a9c903174d5e12f6fde408f96e618bbcef4d06f670fb79ec7d'
    ]),
    'design-intake': Object.freeze(['c627e7856b5c077ac9b6f2395623d0ab440ab9ad02a2a2f983679830968719e1', '8d4ea22f7de43c62327e15dfcb1d37b99dcc4365c96df5e6b68db8bb46b4ac37']),
    'design-inventory': Object.freeze(['abd5671883bb6f98ea452790bfdc05b56d826d667055fbe24d9f7a61405a2d3c', 'e5d6cf67658f350b900f5eb6fcfcc7bab0a286da2184e0aa100aa801dd70c20f', '55446faa95100fb42cdb4caea8f98bea68c779af06b1af70566f404e425432f8']),
    'component-mapping': Object.freeze([
      '35e812770061284af78d1c9bac956ced7f331ca184cb4bea7f3ca04d7f9c95eb',
      '7e23844a21b566e3c79568613659157586f210826a930e1176950b2f5c85ddd0',
      // Before broader return routes (2026-10-12).
      '506e87791b83675dec4c2e54e6b950def9144c1d667a194a72bebccd9ca00f29',
      // Before clarification was required only at a Story's intake (2026-11-19).
      '7d2062e3711ecd9b0eca34f58317a8ad74efbaeb6bf8b4e1c1bf36e8de6e064e'
    ]),
    'mobile-spec': Object.freeze([
      'ca57cd0f5fe383e0f86eb1fcfc30feb18bb0454ef42d17a1eda8ae59565759a0',
      '9b3a14f1f8cbe29965845546967a3122dc560b17419b395628749a1df874da4e',
      // Before broader return routes (2026-10-12).
      '4ecd5cf51485d28136f4ac819b091242b0de8f4fc2fb6657814cd4d100356460',
      // Before clarification was required only at a Story's intake (2026-11-19).
      '4f1831c530c0ad7b6df0cd3a1c4300fb21a765a71d3eb68178faf2bcc29a6f0a'
    ]),
    implementation: Object.freeze(['ac65a5896a978d4bb4fafacb3e88770f63d548dc736608a0872ef80b2a42d0dc', '36d1474a044734c2a03ddb3295b152b282159f693807dda91786022e0d91a7e2']),
    verification: Object.freeze([
      'b76ea4b72e122af77b6c2b42492a929d99fb927cb8cf8d23407dc429e372ea42', '9c15223a3f11cf23bf94000c089dc47d87b63cf2c2a44d2e56a783fd32907493',
      // Before repositoryTests: run (2026-10-23).
      '11caa9e7cf51ecb81ff24eec8effdde40cfdf60fef25f11a54cc97667ae1e3cb'
    ]),
    'visual-verification': Object.freeze([
      'c5d6cce09178cb6780dd21dd61dd642b44da5c5bc214e5bdb81bef7241d36453',
      '472d021acf80e259457dfa19fa80f3fd93e08f998c74d99c2600d0ba37444aed',
      // Before broader return routes (2026-10-12).
      'db0280a550fdeed91d02f337089ebe135912440210f773cc5b83bd76d9508b2e'
    ]),
    // Before the unread exactFileLineEvidence flag was removed from its comparison block.
    conformance: Object.freeze([
      '32fcd6ab14993013675265d3244d9682538373bc8f7ca30f99ec5940a706b02e',
      '9874a43a4d9784e22ae068855061f2fda85cd46ceb4c3a2602acb339caecf44c',
      'dca6d2516087e3b6dd590cf298c6213ab71a875f6c891f0f815959a50ab04fb2'
    ]),
    // Modern v2 predecessor before explicit clarification-off policy was added.
    planning: Object.freeze([
      '54909eadadd1b11f1db764daf5ae3d91748f64b4c4562b631ff76397adc7e2f1',
      '91c8f6571cd05fafac5e28c225e5f08009d27b59ee14be776de7ffff8d4632e9'
    ]),
    // Previous starter required six human checklist decisions at Specification approval.
    specification: Object.freeze([
      'e3fd4a7f7797f8cb7ad10766a74c931b6edf0adba453ba8e19a84b50d40befc7',
      '11ef5fa9479175bd8e27d5a07af58a74471473fe8322116ba6dd7e93d5ccb527',
      'ac393d223b6fb0c09f9fa602a3fdb0a8eeb20dfd1025e8a2851e6fa4736df194'
    ]),
    // Before convergence was recognised by its own artifact kind rather than its name.
    convergence: Object.freeze([
      '1fd5cf156969db6a33e686376399f0d2c3368c7f5ad1c9d229704190a5745e48',
      'd34e5232cf52c5adca8f5a23648a9ea5fd77e4e29f24c858c658c3e495ebf121',
      // Before broader return routes (2026-10-12).
      '88f806558a64d7e46151ed3de100711ae13ff15aa34d020fd8d0c44be0f5668f'
    ]),
    // Before broader return routes (2026-10-12): the repair and later steps of the scenario workflows.
    'scenario-repair': Object.freeze(['5e4dd1839e53e3d3ca5e4cf1e27b1e40631c2e2c4a003dfe54ab9c461d22b186']),
    'scenario-retest': Object.freeze(['0c53d93ca05f0e11f733a7415870a0c20f0fe42996e8e0792cdd1d50f6316d86']),
    'demo-web-repair': Object.freeze(['c5f8108f88c203c8cc96be42575d9cc141940ecdba86cec4a7469aab7b383e97']),
    'demo-web-retest': Object.freeze(['b820b5ded2f398bef0f59ab62b51c46d0a4dcc3ef49e46279fb01610f5607dbc']),
    'demo-repair': Object.freeze(['71d0be49b89929fdf93c6074905dffb09cc4ea4e814bc0f53dc9576d753d0941']),
    'demo-close': Object.freeze(['c9a3059f9d756666653de65c438895031bd90c607e57a963cc94986956c5984d']),
    'demo-instruction-repair': Object.freeze(['670071c6dc5b27e4377e8c1d44b2f928fc89032d83fa5f2b3c488b334ae22645']),
    'demo-instruction-close': Object.freeze(['d92b106ae52576b5da2ad29716b5dfa2bf50b4d414400ce38d2b6fdc9d804721'])
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
      'c5717793fcbb8aaa6626801da1a478cd757b5b96713adf2a02b87948c0babb63',
      'dc0952904a8d2944f3e66dd72eddd4e47c0f8827b98325b0f7f00734602b8ee1',
      'd5dcb613feed5a69dda1123ac922435fa130bc8e7cd9ab6845726c420c0757cc'
    ])
  })
});

/**
 * Every packaged phase as shipped before the registered World Model was removed (2026-10-10), when
 * each still named its World Model views. A repository seeded from that release holds exactly these
 * values, which stay framework-owned so the next refresh can replace them.
 */
const PHASES_BEFORE_WORLD_MODEL_REMOVAL = Object.freeze({
  'component-mapping': 'afe2fd0fb6af77762e9de78c3662b28f98e8e9d523b9f23be45d7621ecc76341',
  conformance: '8ddd3bdc1c6db4bd846be47f3f1c83cfc84e071d5f667327e0197477c3b10b12',
  convergence: '6039fdb0e6e576937fe1deddb3c50a621c9d06ce6c5eb43d17f54d4ddacaabad',
  'demo-check': 'd44f395f4379773a4a496a74d547f45ddd27b707aa2f9a5a9acd04bf369068a0',
  'demo-close': '59c928a6eaea1817132e3a7a8fe8ec5fd44613a9d9632bef9d170d1391899eb9',
  'demo-intake': 'a24da19a6e9e6d971d52e775405edd09e024aaf98b574a52a42f68ffa6054f69',
  'demo-repair': 'b632bf59de3c8757b8561caf88f880a8a9021ad94663ab3cae7743742baa78d1',
  'demo-web-check': '6cab0053c02979c59a906963125d3e9e1c55b39bcb4ae8742c95e9892eeedab4',
  'demo-web-intake': 'd9abac5eacdd842b6361b17facd4beed73633608e251ba6b0f45b9fb8174dd47',
  'demo-web-repair': '8cee05f255b622fad5795ecdcb2b1bc1e1c4d48eabcb8afa83aa7f98defc144e',
  'demo-web-retest': 'f35baf9d1b99c67df246120818f3bd0840917d4684911becda0c12dd45c94d23',
  design: 'de5458692e13cc0c0150b137e28e0071610aa64af4c6200155b769a60352a210',
  'design-intake': '6d1ba33c507c694af35aaa788062bc2a72d78b7f93d67ae4269737e2d01a2366',
  'design-inventory': '1ba81d6b4fe6b252b2a28626e7fa927fae15f3b37f3f021b1cefa4c4f32419d1',
  'document-intake': '7ec868843d5827c6d7bc01e2642d0b10232207fd6fecc132321c652f609a2f5d',
  'fix-design': 'b0cd61ad3efd5d59965bbcd6f916586bd3843d3e9dc826824db3bf80aa56bc76',
  'fix-spec': '90d4e32cda609d2fd96c1f7e32e552ab3d8d21a0a09aa28eff59a36e47ca97de',
  implement: '93028f93ed99fe3a7b1a82016fc65de47a111a88e0fd70a16e8822a42387f05c',
  implementation: 'dbb6a00d8aa2728ac0f791d3ee2a77ca05319e8af127e85f5e236326646af717',
  'implementation-spec': '63959074fb6d939bb186bae23e32eb1d923c9af5362b37cb660a9027c96ac71a',
  intake: 'acee306db6a4fb4e0cb2da7e4c5f9d075e95bc5eddf5179d1250ec9306094b85',
  'mobile-spec': 'e544c0dbf9ab2b2ee674c41b42a583a3ac43cf20db85fdea6f61fe724c0a62f7',
  planning: 'a3754fa844f486f040704b5d59c49fb2725e5d34ffc4fc3add4d2ca316b88b07',
  'poc-impact-analysis': 'da41ab7a95557408f274ac948c5e49256af7a49518b08b2f57cf25262393c812',
  'poc-intake': 'dd898d67cc9b32b52a71839be42157be183e5031c0c84166651e3b73a8765ddd',
  'poc-lite-act': 'b28f65c1adddecccf497b6bfd54e9f0403d731ed702dfe7c465607660878b24d',
  'poc-lite-finalize': '394eb36ea92586141e72344326e9451361feeaa1c470bcb5d35829878ed9111a',
  'poc-lite-plan': '84c10512fee313c3cf749c8955d61ed4b8cfa1508ff9771e6408c7228345b1f5',
  'poc-lite-verify': '576f07dfd8faf2bda181ce81962c3ed5b7155e46b6ad2a02dbd75f505374210b',
  'poc-publication-review': '0b8332ed95493b24e87f0215c878e3da46886520cdbde2a9b496cc3f6e8a201d',
  'poc-test-generation': '6c7e87ea8beca5202a69e08854600c88e989a7765efadc9427043c7e1737964d',
  'poc-ui-exploration': '45c443f46ced246b4c7f9beea4137648d469e021da1c268f4500b7fecedab11b',
  'poc-validation': 'c311bf1fabe8c1e42f445089d09e9d79e2e6134c33e7f38eda816a5050f4e0ae',
  release: 'fedbd35cc1db8ca7478068ccdd7a3c508378fd49745f4fc527481b2010aa2bf7',
  reproduction: 'c60c702afd3c975699dc97220e20244346212bc5ab4c87ce38d9342000901c80',
  requirements: '7b37741acf46c2096854c1f5d8889460e5b7d9eed616bef0a7ec678c83fa23dc',
  'scenario-check': '829dfac2a445fc3daf5e7166b975d3b7997750da4b9a8a714e0ce3290765c15d',
  'scenario-repair': '5f135439746cd2373405ee3cd2b3ec6ead020c697eba3265ac784bcb56aec288',
  'scenario-retest': 'c8ea29959ff1aceb60fe02f5d18427b652bc5e270a2ce0e335368c4d2ed18343',
  specification: '6d95244700a4b9847d949139ff9256f5e7c7a1523e7a206a3c3de3033ec7629c',
  testing: 'df936989f0933f9101ad81e59ff2331e8eaf35069e1aaea6dd249d6d3d3a1d53',
  verification: 'af0c291e1d5b08fd4ebebed61d1f5242a56e97cfb4f1522ba27f94bf6722036e',
  verify: '11a914f06c7e4dc51ac247c2696a6a70f713032a4d80c075f2dbef6b1b4c077d',
  'visual-verification': 'f699279ec984049ef4f4186202e9e963da07a0e41fae1d935372678f6d80027f'
});

/**
 * Every packaged node step intents changed, as shipped before them (2026-11-21): the packaged workflow.yml moved to
 * version 4 and each step gained its intent, with reasons for the settings that differ from it. A repository seeded
 * before then holds exactly these values, which stay framework-owned so the next refresh can replace them.
 */
const BEFORE_STEP_INTENTS = Object.freeze({
  workTypes: Object.freeze({
    'benchmarking-a': '683792ad3e475d6150b924c42fef6a78c8df657b331fd6dde45417db2797491a',
    'benchmarking-b': '96868ea267f0f37892d70bca6b527dfbf378b7892c9abdb062e2375b0acb104d',
    chore: '45d990b4cae0c7d18465d11d82369a2f0e89f38b8e91bca4e496dd1a189e120b',
    'classic-delivery': '0b245f5b482f1baaf8507cdec69ecbf97734adf2e2d0c61d6fac3c2b6317057f',
    feature: '4d7a236a08e4489a2c5ec695c48ee8869237cfac75bd0c9126d2845557ff260a',
    'findings-remediation': '452621b65a60839a2eb8933f632d9fc7f2d5a6a491e17f6e93c5ec86208b39a0',
    'poc-workflow': '2d703ea2ba9712a859cb29a4f26346d9e23071ca6445fcca6ec821bb5cd1ef3b',
    'quick-fix': '01398a0d4124462b07ee451bd27ee9b1b4af94046df803a31170f2efbf87d0e6',
    'spec-code-test-loop': '82064c8180434a842b252dcc1dd447ce1c9bf82d0e2a9926a49afee18abda6eb'
  }),
  phases: Object.freeze({
    'careful-change': 'f1d09fc9b2581f97a19b8b6557810ba62d3f98bb92b2a26a4edd1c09d55c5cef',
    'component-mapping': 'd418bdfa5cc56ea3cba624ed8019c1e9348ec2e7456634b4c6746ae26264a584',
    conformance: '8aebfffa8ed9c22fa75a2e69800f73db16a7ca6b53ed02e60a14646b52736b73',
    convergence: '00d346ea1b8dfca976e2aac2f6b8a7cabd17b6e31b40dd3c3826d1d952daeaed',
    'demo-check': '20072760b4cc6db323ab0676c3bf8704c9d2b849074ea2ab6884e45984bab4de',
    'demo-close': '4e974360a3b5c1b8e2be9d90782201e1fcd8f9918d956320d6da4e81b7bb5204',
    'demo-instruction-close': '6da535a7c13aba8941a612e90567c575f7f97d3d2a50cd8ef7a72d57bd708044',
    'demo-instruction-intake': '521a52d220ad7df8dc67933a10a7410f60fcb3839fe585cbcd3b9b38d078c1f0',
    'demo-instruction-repair': '7e8ae07b42be559af1aec7e521065a42a8b58ee834435d2a3478bd288494cf90',
    'demo-instruction-test': '03d2174959b490fc63ab3db7575a6b96577e4ff99e63fe3c1b62f097705ea5e9',
    'demo-intake': '45ecc0c63654b37c2e396706a286ff0c1d17136fbcebe54c9bc94fd3a516e062',
    'demo-repair': 'fba44208099c3f78541f5ed2b69a5a5733437ce93f0a455bf350ba360668832c',
    'demo-web-check': 'dd3b828027bc70a9501a9ac0931958667f4664511a62f4d33bd829effb94bd19',
    'demo-web-intake': '5d4abe5ce3d309ada94f814a00b949a7c895547d10215369da550e9651cdba69',
    'demo-web-repair': 'fd73ce3858ad7522d40e15a6a3d2d03a42d1e71ac17fcedbaeb89b8a808103c1',
    'demo-web-retest': '35fde1ffb133547a031c995504ad3881ca60eb8d10eebabda44121fe442a4b62',
    design: '4ea4ca5882e847a14c9a70ae2df1e7bfba75287c2a611a96f03fa73a4a77ca34',
    'design-intake': 'e4d0371c1c702461dddb8f25d3f93295dc895be412324aac28d93edf39de47ae',
    'design-inventory': '00e2265bad948db2bc7c1f9b629814bf954b2c3e321d07a64dc696c10fcc4117',
    'document-intake': '2bce3e0ff60252660b3514153296a55c36f9ac3e1dfaa7cdf51259845f8500d1',
    'findings-intake': '8f096ce5c0680bff417bf0861a69b974bdeef710e5fcfad90cf2918b90a88859',
    'fix-design': '75a11314627f861c845d0556048de55d7cf6f3c524ffca7045299bddd28b3f82',
    'fix-spec': '19a5e378212dcb1a642f339781b2d1a63e4e79556b4640d73eef549fbb7df6b8',
    implement: '2d1991614f6090ee1fa4c97c88ae67a158cf93bda49650308766fe181c2b55d8',
    implementation: '8391515ef54d176c0214f747c343f1e0edacf9b840a94e01ca450ea1106402e9',
    'implementation-spec': 'dcb397a2b8b6c8df579dd45569cbcdf24d2b07b7d41aaf4a3f946f01c22232f7',
    intake: '3a7cdbe743b19870d809c4510a1ebdb0d9c7b49587f90f113453f46172e14933',
    'mobile-spec': 'e9629def6632cf242000278d9d2eb80081809e712303410363f33fae895ccdcf',
    planning: 'a588b38f249f6faf6b2a4334f6467c640b38eebceba39586dafd25805082b376',
    'poc-impact-analysis': 'e722954583c0fa43793052d8ac020fc08b384f5d8a4400a96252c9c98a0021aa',
    'poc-intake': '44a071bdc3aede9203b26aa55ba77be32879f8339b008300ab0727e8ee188cd4',
    'poc-lite-act': 'ab2817ad585bac878ab86b603c79014ca84a59f274cd5325f41df477f9870f3a',
    'poc-lite-finalize': 'e4aa7e427883748714293b103bf105056a2eea47f39f13314b6d8abae6d220d1',
    'poc-lite-plan': '71d5059aa5a9a37d34722a5b540f550209b87a90dd4d5b1292389397eec54d9b',
    'poc-lite-verify': '5d3dead80d67469a1c2570fa03f8b996c9f6aa897fdc7131d182f202304156e3',
    'poc-publication-review': '9308d29f806e37c959801e44122887dd8c41eaf6b6eb85193018448f01000faf',
    'poc-test-generation': '82f543cedf84e745444c681be0360568c06829289e13584ed39cc2c59c7305b1',
    'poc-ui-exploration': '7ee802db5756bbedcda38384c9f069d5318565af036e9b78feba6d75b1898668',
    'poc-validation': '63a304a682b7f426e60ca560449531b707ee7448ead839512d1403a044c8e8c2',
    release: '1619c2b5da0081e1412a8989abdc2f13aff4599424bafff3b8d2fd30dddf5d94',
    'remediation-plan': '7689d8b7ab5c10c31e09f9fa807e82a3e6b1886c9ca4d31e2f2081eceef45213',
    reproduction: 'bc21cfb570542e87db5358ced1c82e8f88c3efb13102ee4f8859522e5536dfc4',
    requirements: '9f49f6ad7d3da48dbc73f252c060b834c5d919a3d1dd436371a5584ac54c7a9a',
    'scenario-check': '866e2fe7588272b2b7ef1132c37e8a36cecb4947419b733889a919ff5ee03f17',
    'scenario-repair': 'cf0575cfaedb47919f13f239d55a9c6508c70086508e6b60a4df659bf3996e55',
    'scenario-retest': '57decaee448ea9be8ab55b625aaa38f323b5c27797cc1336cbd7b9d177592de3',
    specification: '58c900068d634f95ed90bd5dff25741a1a948e33c802f76ea4af7fc2c851ed39',
    'test-run': '7fecbf9f931ba41decfe666646cce84428b715e2964bb191ceff08a87151f845',
    testing: '85cc97324578f64ce95470a36acc03ad5d585ec4ce7a6d50a2b44f4fae0b8007',
    verification: 'eac367d76e194fec085356e3413db5e333e17c7e81b2f1bbc4d06aa8f3161061',
    verify: '3fb605371c18b1a2877f4447f164f0e7893c1ec56095e19fde7aa4b2d5d3dccd',
    'visual-verification': 'e929feaf22bc30c7f8d698909f4a0b3c08faaa3b29cf4379ca6b270150086f60'
  })
});

/**
 * Every packaged node the adopted step-intent differences changed (step intents Stage 7, 2026-11-21: test steps change no
 * source code, approve twice for the benchmarks and the POC workflow, questions when needed, attached documents, and
 * convergence approved by SFlow when its check is clean), as shipped before them: as version 4 has it and, where that
 * differed, as a repository on version 2 or 3 took it. A repository seeded before then holds exactly these values, which
 * stay framework-owned so the next refresh can replace them.
 */
const BEFORE_ADOPTED_DIFFERENCES = Object.freeze({
  workTypes: Object.freeze({
    'benchmarking-a': Object.freeze(['a77226943dd3d984efb8fe8652f0a631b7a5790cb887431c033ddc8c0ddf7a1c']),
    'benchmarking-b': Object.freeze(['2d77572d3f727a85befeb614d115cec2dc4a4e1b26456110d1e5985353b4b935']),
    bugfix: Object.freeze(['4102c9f0f0574eba7aeb2e0c9bf6cc4fd30169525ad3ce3c1c64fc65693f789b']),
    chore: Object.freeze(['e77e2382540ec9b0de3db63a425d007a944ccebb3cc8952b4c16fdd85ddd6c2a', '20acb3db0472805d981bf8d0d2870d97ee6139895eb9f18a8bd80e471c38442f']),
    feature: Object.freeze(['34f4956a9cdd565f555cfc69b89372790c635103b3f57ab9438f4e4eb41a8ad8', '313a6f7fede2a3da7e1c5494046d396d19bf1fcf2b94ee2a172830c8c46d22f5']),
    'findings-remediation': Object.freeze(['f67b902f348f735f418321a5ecb74bd6bb13e826271b58d179497648dc83c688']),
    'poc-workflow': Object.freeze(['2f89981a4026255380ccbdfacfa1df162577ef85eedbfd31bac2313f1f08a774']),
    'reference-driven-build': Object.freeze(['459ae3ff12dbb941ca7e603b2bdac2fb062868717ca364ea4c6dcebc3c6f7f4b']),
    'spec-driven-standard': Object.freeze(['46ffc1360346b4e65bea9f074fa08f6f904fd93b67fa15948b4405619887c3ba'])
  }),
  phases: Object.freeze({
    'careful-change': Object.freeze(['ca6aaba67b9cf9e8bdc9be8da84017dd1b49c06d0ba4c0f0af95ffeff33abd42', 'bbc58dac2fcbfd0f36d7790a08f625f32370a1681951cdba3e2130849ac0e76e']),
    convergence: Object.freeze(['04fbd5f4ccde1ad059f67d940b9fdcdb41215b90357f500f625c9775c9862784', 'f68d481966719b32c2d0a591ebf1be9b7aa314316d10e04356a8438393ff8373']),
    planning: Object.freeze(['cacf37d1e684a7540fcc730e583ead911be3521b93c19c2e2f09085645cc6261', '96fce9f45437f54d095a3f42e094d4345b550b27a7470eb9e1941916b7f2444e']),
    release: Object.freeze(['7b030f85dee39f2762e1c973f99fe99118d5a9d933dc661d7cff72eb1bc79c3d', 'b3228d91bdae3a55f0b4389ff473a00b564794fb45ee1ae69262dc3dde6b2811']),
    'test-run': Object.freeze(['e70dabd498a904b7a1b739a21e50bb8bccd53b1449d4b8de3f81320264b9a83b', '272c641c63d9bd3498bf6cff8f7609cf3cd11e13e2ae31bc187eef0578f93041']),
    testing: Object.freeze(['0596101e575c768228880b8d55871b37d63cbfa0b151b86e4d0982a7f619baab', '50c0b6c43bf215cc6d807d5b125a3988c139f19b19230bd629f0d39ef79cf654']),
    verification: Object.freeze(['5205092525f5d83b842ab56b3c28e3d8713208960718e65ac0d7d3b41bfe631b', '8904d083a842ee24fcfb0ff2c73e7fecdad079c70872ce009a9e906ede6d95a5'])
  })
});

/**
 * The current nodes as a repository still on version 2 or 3 takes them (workspace-configuration-refresh.mjs
 * packagedWorkflowWithoutIntents: no intents, reasons or `automatic: off`), where that differs from both the current
 * node and the one before step intents. Framework-owned like any shipped revision; test/packaged-provenance-registry
 * checks every entry against the packaged workflow.yml.
 */
export const PACKAGED_WORKFLOW_VALUE_SHA256_WITHOUT_INTENTS = Object.freeze({
  workTypes: Object.freeze({
    chore: '20acb3db0472805d981bf8d0d2870d97ee6139895eb9f18a8bd80e471c38442f',
    feature: 'a4ff1b7326d8afeaccca570b37b56a2fc6e1754cd848dfb2092f0e03d66bc928'
  }),
  phases: Object.freeze({
    'careful-change': 'bbc58dac2fcbfd0f36d7790a08f625f32370a1681951cdba3e2130849ac0e76e',
    convergence: 'f68d481966719b32c2d0a591ebf1be9b7aa314316d10e04356a8438393ff8373',
    'demo-check': 'dd2bd92514e184e3fefde35802787da42e3441103217a638c85bc3a779ba5a4b',
    'demo-instruction-test': '36fabea3cda4b5a1e29a38cfdec901bac4b0eeb07334d0f77232abaaf8e337f4',
    'demo-web-check': 'b412140ce3fbee77cb772ba72b4a333f102937509af834c3205269f0e1872581',
    'demo-web-retest': '61d6bdb6d25fd18bb9bbff640416465da0919e2054cc32ade1eb87a3503e0e20',
    implement: '9e4c09566e0a1bfda3bdf46cfc562cef9ddc6dc71141d411f469b70279ed508e',
    planning: '96fce9f45437f54d095a3f42e094d4345b550b27a7470eb9e1941916b7f2444e',
    'poc-lite-act': 'd088a69e817b08ef1080a496f4e709067e601e688c3d3709afa73a749003e084',
    'poc-lite-finalize': '4531f76d5e14219a01054ca0691afa2a688d4e2709364d7dd48eeec7e9da2697',
    'poc-lite-verify': '525ba10c990d62abcdf66b585ae9afba3078c28948091cfe454b574b4a129de5',
    'poc-validation': 'fd0a14cdf94906c18c68c7b880fadcfd1526498fff5e41e68972fd35794171d5',
    release: 'b3228d91bdae3a55f0b4389ff473a00b564794fb45ee1ae69262dc3dde6b2811',
    'scenario-check': 'dea9af470d6a55b2e4c4295ab6c55ed9c087fe593c260ae6ed10e4e9ba83e601',
    'scenario-retest': 'd8ff6cce07f1b7071b03fca9c05a40236582c09aa0e8eee1a88ad62fbc49cac7',
    'test-run': '272c641c63d9bd3498bf6cff8f7609cf3cd11e13e2ae31bc187eef0578f93041',
    testing: '50c0b6c43bf215cc6d807d5b125a3988c139f19b19230bd629f0d39ef79cf654',
    verification: '8904d083a842ee24fcfb0ff2c73e7fecdad079c70872ce009a9e906ede6d95a5',
    verify: 'e8e0d0d8d784244b1a8e9a547af5682c47cb8dbd4c2bc63c70df1264770b4d0e',
    'visual-verification': 'cae7f5c5220831c4eb830888fe38a0515edc78c3dae55df01b37960078cfc55a'
  })
});

/** Exact canonical hashes for every workflow node shipped by this package release. */
export const CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256 = Object.freeze({
  workTypes: Object.freeze({
    'careful-change': 'a6ea3be48cf4ece09dee0adf5f9088ad99cc02826fd2fe54bbdc29feb6baaeda',
    'test-run': '17a4c04485f1515b786e3d06595f36f05d6f707bad3c167274bfb084e53f000d',
    'demo-instruction-test-loop': '37355eeff7baba479e08f925b068343f6b53f277906cf7f0d8a0627ba6fbbb1a',
    'benchmarking-a': '903eda0c8b99351b6993c06498bdcc1683237d864e6c55319f806a91b9fee89d',
    'benchmarking-b': 'a6446501c81f3fcd4bba484b95652652153ddcea34cf6f01d74e1c93cd99873a',
    bugfix: '8012b5293b1fe6c9792ddf64d8267ef1fa70ed76042e53b2e3498504411e4c90',
    chore: '9196bada9e0449df3c00f57e923ad4b04d9d04015850a1bfeec1888881f14e03',
    'classic-delivery': '9991f59f3ba6df48d9e5603edb78e7d33b303b6944f8fffa0e5e01f28fda9574',
    'document-test-repair': 'f2d5aa4742def2f0a771660d229089ede1ed3a0bb913404c362b703dc703feca',
    'demo-web-e2e-testing': '6161336401af54bd15e26c17cee6e45f43cadff36a424e051d0fbf285fb4af9a',
    'demo-check-repair-close': '8b7a856aa801154f306e6a42375fe65d00f6977bac9129d98f202b6ba01ce8f9',
    feature: 'acca9a89695829b1edadbf6892449a2d09b94f3e2c5a1b0f5319aaf00b45b174',
    'figma-mobile': '4bf49f8560fc79d59bc91ce46fd209a64723a9d4cc35ee649364b84c189a8772',
    'poc-lite': '5f9265d011c6427724608ef3d9ac1dc615f0b78d40bc12f06ae362a1a70719b2',
    'poc-workflow': '5a51383a2b4679ec3536b0089dc4d0a15b2e947f1f3871e5b204e054b283c6c3',
    'quick-fix': 'be9ad15c5d199f58b7c0fd7e39d1889fdefadffb2453d8373325abcf482d04df',
    'reference-driven-build': 'b95a9da6caf80d18b7eaa134ee7c484eff81511bfc4eee8cf5a4284cd1f1b862',
    'spec-code-test-loop': 'e494c9de72ee485d92c2a567feb2e788241be05fbed170c24564018ed221cbba',
    'spec-driven-standard': 'fe1ae0c9578c7f722f112453df9ecd934733fb28758f9b7aa906a01676daec2e',
    'findings-remediation': 'c49256be0c8dde9bcce28af22305d1ce0ef5b59964022fd421ade63331d1bf32'
  }),
  phases: Object.freeze({
    'test-run': '0bc648139486b4ce011e301fd49d907b899913e4214eae5ea6aa0f85325d816b',
    'careful-change': '0aa8f013189c97f582179f2dfa6f29997e3d0ce8c0ad55756959cad41b93969f',
    'findings-intake': 'd8d2bd4286f8df766497ad2b36ca76346ca75265dc733d125c2527a1f4c6fc03',
    'remediation-plan': '33f70899b252699d7fa481534af7d754b65e41e8fb9069c712216be1f140e606',
    'demo-instruction-intake': 'f93743f3befe3fa341e59e77982baf7eab0154453b073a886a2414bbf9fc4ed6',
    'demo-instruction-test': 'c7ad686ab76222b7821c3b21deecd166470487e666aca3d3eeb4c79eecc2d64a',
    'demo-instruction-repair': '9bba82e5dc3842a48407b1636ed87ad70b9508986ca61de7b6251499caee280c',
    'demo-instruction-close': 'a4d5d6f7d415acd3c15954c8730a9afae7b8115a5def381ffca8f52b9c12c1d5',
    'demo-intake': '6ca4c26db12ea5384bf5ea4e08a6b562e2e18ca7d08e46d221f04651f730a395',
    'demo-check': '404d2893a6324fd9af8f5497cf66906ce36eb8ad7d22cc499da81e55fabb5775',
    'demo-repair': 'd6e84b965660c5d03af175f6fa34aa3f922accc9fd00aa02cd0263d600f01954',
    'demo-close': '52a85c12220a0a81e0625e52e72f7f506ec61f75911c72fef4add907da9a76be',
    'demo-web-intake': '691090a4ef4180bdb24c42a1338c3d655177f2c6923c2a3e3af4524a30d398f7',
    'demo-web-check': 'c8a0df5e0989fb0ad98316536ec83f56cd184f3a69bbfa0fcba06b624a276657',
    'demo-web-repair': '076475beee4400cd8ea9500c5db3574586d492da7bea96eef582bafac90e568e',
    'demo-web-retest': 'f543b8a178c10beb050f0fc93167d01ed7730489b04008bf616640db52150e0d',
    'component-mapping': '71a6294c4b68bdf3b5e60ec679ddbec54d99bb611f2902d451b42c6098432585',
    conformance: '2175f769afdfa108e3eaa38637967c7ad6816267cf2d4afc254a1fb9d4e9aff5',
    convergence: 'c0f6654d4592da0631bdb1b83242b4dc2d1d1b738fb19518b5cc484955b1f0e1',
    design: 'e01400e17b4be1fe637d45e29edbbe5c47b38e53a73825d54d0a269fc1217d20',
    'design-intake': '9073c1dcadb11224d9c56dd69f1fead295bc0cf854a2062607f80dadab1e660c',
    'design-inventory': '3f773571d171f2e8bad88809a60000fb55a03217aa043903449b9165606f06fd',
    'document-intake': 'b58473561cb63bfccff82dcc0790049e1ad854c8d19fa39b60ba6d451287d75f',
    'fix-design': '2196e6a614eeed151f3295fa1d3eaede24590ca98d50c6be16dcc5d1021d0a0a',
    'fix-spec': 'f2a38dc95f7e412bf2786be439431c1ef6bfd10a50718f56bddf25baa9353a95',
    implement: 'fa4b2dedad9b9d64cf870fa4145f5e16382fbea2099b8980075730d696c8fb9b',
    implementation: 'ece9fac3fd278df1b4f8b917f208552a3fb75821d93cf913a9bfa56b424b9c69',
    'implementation-spec': 'd8f2d0d6e68478201994f3e4c43978a9c42310bef25b31e57d511184703cc6fa',
    intake: '32425664b14545ee7c73125bb921dc429f66967735a23721b6f783900ee0253a',
    'mobile-spec': '9313e36c703d3d6b8715c6a5825c771cd586dafb0408680b16b3a90fa8543dad',
    planning: '5b18fb970169be0acf840947b7825d1862049543aa3166e476a0a39888f20cde',
    'poc-impact-analysis': '07d11535dcd75c59ebccfa43ea52c5460fafec0f1655340eb5b410a5266a8e77',
    'poc-intake': 'ca60fd9d2be5ef945f726580253ce336975efb7bb4a756d72a262293289e0dd5',
    'poc-lite-act': '415d946ca9db0a880590a2826ed68b06f45ac55051edb3160ac7cc3398953c52',
    'poc-lite-finalize': 'd0fc406bfd1d97a86b1f5323fc543c5cc24f5c40a585558e6167a5d33c418107',
    'poc-lite-plan': '8f3820222ed0d0a9d157f1a072cda1562259d52d7f756664f0d9645fec76a990',
    'poc-lite-verify': 'a61406a5b4c750b179548134e50ff2fba6ee98a98188f81bd9e7ccabaae495f3',
    'poc-publication-review': '99b9057b0b412b83428656acfaa9791f35a711ba91d1b417f7815df4ebcab46a',
    'poc-test-generation': '137588e3b97ed52ec51377b9774a3599670864e0b6d279cef97ceec1218822af',
    'poc-ui-exploration': 'ae7c58aa9096d6db162eee647b057fcaef61c7e2b539c2eb1eb2a8fb82efc10c',
    'poc-validation': '3a552b2c77d92f75869d865e27f4be296a66ba26cb01070c1882594b78024012',
    release: '65dc9882d3da9bb7f7326ce393b4a76df02fd684b28d67ff04c78432d369680c',
    reproduction: 'c0c5d2624809b0a6e5bf574c2dd28d3bf541f5892b9ce33e04b1470c17c3a5b2',
    requirements: 'b63ec5fa738ece84baf26a77f3923e7b13f6dc66c94fb23821534edb764a63c4',
    'scenario-check': 'cb5181f77115795fb7bede094f044b0ab9b2bb08a25a7cabb4bfac0aec5ff9bc',
    'scenario-repair': 'd0b91e9a20d46b80c7ac2b59140245fc3b94480c13e19d23f17427022ac03333',
    'scenario-retest': '7e3971acf7328dc062ef3a77d011d3536b12f5c2ff8752cb1ef770a5a390ae44',
    specification: '33441e641a89936533be4afa9a9663bf2fe2be4d4166a8b6ac2d78d0abdf67db',
    testing: '8b722f317db603dfc9931c27392e9a7860d1e9d0209dbcc4b83b12ab35be4db8',
    verification: 'cfd67b89da97269d90c2545872a24996d773952c9c4ea813472ce836f0e5d0bb',
    verify: '3f8d7783d455b98a5bde58e2dfd2e2ecbf0c7f786e93253a9144630cbbbced0b',
    'visual-verification': 'eb08d123a3b3646651bf6bf950a466a61b7ec09495f38c06b92f0565034c0a5d'
  }),
  artifactSets: Object.freeze({
    'spec-driven-planning': 'bc18e7338a3819b75a65ed001f0cd7843f3be8c9b3908db769a6578d97f44d12',
    'spec-driven-specification': '25addecf58a557501a48e80e006657dad96e99ea6c916d76d07b96946dd66449',
    'spec-driven-verification': '1cf89e7a577eab988518048b20f540f115227f6fc98e275a9e26be52dcc9f3ff'
  }),
  mcpServers: Object.freeze({
    figma: '30ef371d29021a7f50a1c5bda73f022c727998a6ae99fd57a3e51335ccaad9fb',
    'demo-playwright': '9d5031346fe312ef3cd237623aa53a69d6f87178bdf33a15e206a0a5882ddcf7',
    playwright: 'f5021e802e3a858f38ed9d966cc0f074d0ec7635b1c15d8288331900b4f0b508'
  })
});

/** Every exact released workflow-node revision accepted as framework provenance. */
export const KNOWN_PACKAGED_WORKFLOW_VALUE_SHA256 = Object.freeze(Object.fromEntries(
  ['workTypes', 'phases', 'artifactSets', 'mcpServers'].map((section) => {
    // Whole-release snapshots, one hash per node each: before the World Model removal (phases only), before step
    // intents, the current nodes as version 2 or 3 takes them, and the current release.
    const snapshots = [
      section === 'phases' ? PHASES_BEFORE_WORLD_MODEL_REMOVAL : {},
      BEFORE_STEP_INTENTS[section] ?? {},
      PACKAGED_WORKFLOW_VALUE_SHA256_WITHOUT_INTENTS[section] ?? {},
      CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256[section] ?? {}
    ];
    // Revisions kept as lists, one or more hashes per node: older releases, and before the adopted differences.
    const lists = [HISTORICAL_PACKAGED_WORKFLOW_VALUE_SHA256[section] ?? {}, BEFORE_ADOPTED_DIFFERENCES[section] ?? {}];
    return [section, Object.freeze(Object.fromEntries(
      [...new Set([
        ...lists.flatMap((list) => Object.keys(list)),
        ...snapshots.flatMap((snapshot) => Object.keys(snapshot))
      ])].sort().map((id) => [id, Object.freeze([
        ...new Set([
          ...lists.flatMap((list) => list[id] ?? []),
          ...snapshots.flatMap((snapshot) => (snapshot[id] ? [snapshot[id]] : []))
        ])
      ])])
    ))];
  })
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
