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
      '07788c17b175c7cd6abe11d719022fa041c28f28227d3e01664c3aee3c61ae8a'
    ]),
    bugfix: Object.freeze([
      '3ac82069488a0728421c7c86d9a47b29b13bed568be47a8c67fab7c75a0287c3',
      'c1f0c3bf9e28757f0a60dea93412dd258890d73b82802227a825ada21bce4ef4'
    ]),
    chore: Object.freeze([
      '327de2a67c41d50bccc308a5925c2025f19efb170e1a4f1aa20cec5df9f63c67',
      'c5ffa49fee9721d9fb1e7c55d800cbd13b7d045dcdde800fbd42fb085986139c',
      // Before the chore intake became its scope-and-plan checkpoint.
      'bbb46f247a676e737505f28c6b06638dddbf47108d324ea6c4b15d97632aa9ba'
    ]),
    // Before quick-fix gained its scope-and-plan intake and POC Lite replaced its planned-claim
    // opt-out with a declared scope omission.
    'quick-fix': Object.freeze(['6ee5ad86a29a3805d914552eed7d0b5d049abb8044ea98365df10dd3fd5cbcc3']),
    'poc-lite': Object.freeze(['87eed6bd5881b47c0cab5316d96c7652b114f43863fb0ceed1f1615165f262f0']),
    'figma-mobile': Object.freeze(['d165709b28aa97f2a2d4416d19cf7cdde14bb9fa0f1632b30733ff4e2c266e52']),
    // Modern v2 predecessor immediately before the guarded REV pilot was added.
    'classic-delivery': Object.freeze([
      '8334062f0d4d0e5295d3ba1e3ccc64bef8901d3cdbccdb2ab880cd33fed20111'
    ]),
    // Previous spec-driven starter preserved only three specification headings in downstream
    // briefs and left implementation clause coverage advisory. The second revision took no
    // supporting documents after Story start.
    'spec-driven-standard': Object.freeze([
      '3f354e9fe3bf1de8bf2c5c2c1e4e135e9bf5ecbc13d34b2e8514000f784d03ce',
      'cf9cda3f0927f3b32fbfd585e5c2c7bedd9f6e7d0821bfbe7a0bf6d0e46d2461'
    ]),
    // Took no supporting documents after Story start.
    'reference-driven-build': Object.freeze([
      'ee3b8742aaadf5fcc04735833a3db98431b34fd11231d3caa50279e8eb3eed74'
    ]),
    // Before its phase overrides stopped naming (empty) World Model views.
    'benchmarking-b': Object.freeze([
      'aa433bacbaead95204b96700360598b5e2e1c682ac1a5846d6fa415adf1b5548'
    ])
  }),
  phases: Object.freeze({
    // Native v4 assignments supersede these exact packaged legacy revisions.
    testing: Object.freeze(['4ecef918781975e253ea4b85baeb635a15966f9eb9b24c68815ba1cb54e18e09']),
    'poc-intake': Object.freeze(['76811191e717df47e168692e756258fcabc7ef9ce041b5da4ab48549509fec98']),
    'poc-impact-analysis': Object.freeze(['2373b60e36c6e9dea243ea23da8c72a4fd9350520aa3216fc35db2f7ea05cda3']),
    'poc-ui-exploration': Object.freeze(['3fde897460ee03d86cb101f528767b9084e51c4e4bd265d0fbc9fff77a624a74']),
    'poc-test-generation': Object.freeze(['30e4071d25e552e602a16ee9f97c487c48fa343ca98a7788b68a8b59c6cfc062']),
    'poc-validation': Object.freeze(['cfea9285e450eb20fd1ad3435da334beb56646612fa38bd33e5dcf73d4803384']),
    'poc-publication-review': Object.freeze(['af1a2462810e87ce834abe2156ff28985a9ae25b1def62b8367f2182806d7231']),
    release: Object.freeze(['ea1d875e603e54c8621eacf8c0e23fa2d2c20d2b9358c479b4eec6c2731f1d2a']),
    implement: Object.freeze(['23a79bed9ddd4b5e9ac014dc70385a673ed32c7650b6859ad90d2fefe71a3705']),
    verify: Object.freeze(['b223f79a5b01215f4dff056c33711c0bc96fde20d9ec6fa8f8c88c6dd5e12875']),
    intake: Object.freeze(['9fc6c2cd2343e20f069ff01dbefadcba65584f1d29ed21a74a7ef4899bf89629', 'f8d4857dff76ed804794c43496adc841113bb89e13a2ae6a28182396777cc8ac']),
    requirements: Object.freeze(['360a64821e529395e9ba85bf6d80270ca16562323f7fa535494c6719616d44b1', '2d6d5be32c33763f982421fb4072040f6ef8f94d8310afb69c5787fe3c72b0fc']),
    design: Object.freeze(['f7ee1f2db131d69f8b8bdca489722ec0142daee15e7bcab4cd2e69e1d2b6ab32', '07de52089a44ac8a5716ea916cd879d71c1fc60298058c85ad66bee1698a0877']),
    'implementation-spec': Object.freeze(['b7c27b6097c2528a43e6b7b3ca46abee330616dbc38446117568d4b4fa887a98', '10fd283a42cffb449fa1c31c3d0feedc713cdcef6286c16b56d50aec407a3dca']),
    reproduction: Object.freeze(['493668d016cd6d280c31011fcccfad2017b2931a8bd5871acaccf561efc1063b', 'cb404fb39200c909784cdc079818dbac7c34a3c06c0c2630d2256e6c492bac60']),
    'fix-design': Object.freeze(['738a2da6b1a6777785f500055715c2474ab9ebc20904d120e3f864916a61ecfe', '49ce60f68b88deef9b910986f10d18db062f44789931966793aa71835908335e']),
    'fix-spec': Object.freeze(['6716d50536dccfa1ca58e5f85e4ce9a21f1c95d183397546645bb6156074768d', '05f34619ab79a6120d58263eb68d486e51007d7e8e6ecd95caaf6723dff3b9a8']),
    'design-intake': Object.freeze(['c627e7856b5c077ac9b6f2395623d0ab440ab9ad02a2a2f983679830968719e1', '8d4ea22f7de43c62327e15dfcb1d37b99dcc4365c96df5e6b68db8bb46b4ac37']),
    'design-inventory': Object.freeze(['abd5671883bb6f98ea452790bfdc05b56d826d667055fbe24d9f7a61405a2d3c', 'e5d6cf67658f350b900f5eb6fcfcc7bab0a286da2184e0aa100aa801dd70c20f']),
    'component-mapping': Object.freeze(['35e812770061284af78d1c9bac956ced7f331ca184cb4bea7f3ca04d7f9c95eb', '7e23844a21b566e3c79568613659157586f210826a930e1176950b2f5c85ddd0']),
    'mobile-spec': Object.freeze(['ca57cd0f5fe383e0f86eb1fcfc30feb18bb0454ef42d17a1eda8ae59565759a0', '9b3a14f1f8cbe29965845546967a3122dc560b17419b395628749a1df874da4e']),
    implementation: Object.freeze(['ac65a5896a978d4bb4fafacb3e88770f63d548dc736608a0872ef80b2a42d0dc', '36d1474a044734c2a03ddb3295b152b282159f693807dda91786022e0d91a7e2']),
    verification: Object.freeze(['b76ea4b72e122af77b6c2b42492a929d99fb927cb8cf8d23407dc429e372ea42', '9c15223a3f11cf23bf94000c089dc47d87b63cf2c2a44d2e56a783fd32907493']),
    'visual-verification': Object.freeze(['c5d6cce09178cb6780dd21dd61dd642b44da5c5bc214e5bdb81bef7241d36453', '472d021acf80e259457dfa19fa80f3fd93e08f998c74d99c2600d0ba37444aed']),
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
      '11ef5fa9479175bd8e27d5a07af58a74471473fe8322116ba6dd7e93d5ccb527'
    ]),
    // Before convergence was recognised by its own artifact kind rather than its name.
    convergence: Object.freeze([
      '1fd5cf156969db6a33e686376399f0d2c3368c7f5ad1c9d229704190a5745e48',
      'd34e5232cf52c5adca8f5a23648a9ea5fd77e4e29f24c858c658c3e495ebf121'
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

/** Exact canonical hashes for every workflow node shipped by this package release. */
export const CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256 = Object.freeze({
  workTypes: Object.freeze({
    'benchmarking-a': '0a18e2ce95010eee32b209c98e1e9ab9d3a9993e78ca10f23938b2d3fe3d13cd',
    'benchmarking-b': '22b76b63947822eff26a76c5b360c132cfb24e81ee4f6975201511ea19669363',
    bugfix: '39ac9d457a906eeeae595d44fa379b709c4ecb77f2992b30d54b327c1312fc24',
    chore: '7d55217aa976c51a702616daeccd8829ca91778839985ae8c4dabc3336645597',
    'classic-delivery': '98cc169510f82d9e046df5471975cf354b7afb7d1acacd0ef0c91b5c51d4f039',
    'document-test-repair': 'f2d5aa4742def2f0a771660d229089ede1ed3a0bb913404c362b703dc703feca',
    'demo-web-e2e-testing': '6161336401af54bd15e26c17cee6e45f43cadff36a424e051d0fbf285fb4af9a',
    'demo-check-repair-close': '8b7a856aa801154f306e6a42375fe65d00f6977bac9129d98f202b6ba01ce8f9',
    feature: 'f69c7d96643df7084e58aa5eb6692a703be004d21d31d06942dbb9a6962a25d3',
    'figma-mobile': '145c68b32584aea0b8b6332db9558c5f06b3cb85e346d737a57c8b7e5f07c6ee',
    'poc-lite': '5f9265d011c6427724608ef3d9ac1dc615f0b78d40bc12f06ae362a1a70719b2',
    'poc-workflow': 'dc72ed2683f76ed9c561ffe0135b442e8eb88202a661ea39031545d29a965d75',
    'quick-fix': '01398a0d4124462b07ee451bd27ee9b1b4af94046df803a31170f2efbf87d0e6',
    'reference-driven-build': 'a577515ed38c8f6d12c82890cc7076ac3ddf06d22370028d3e52c3f911acbc71',
    'spec-code-test-loop': 'f6a911e589320f8fd63b4933c61b2656068c9757d55267e60f2e47c6e5259e3b',
    'spec-driven-standard': '6528062cd8e1ce663f60ebf361720562f778a03bc808e52158de07bb6cabeacf'
  }),
  phases: Object.freeze({
    'demo-intake': '45ecc0c63654b37c2e396706a286ff0c1d17136fbcebe54c9bc94fd3a516e062',
    'demo-check': '20072760b4cc6db323ab0676c3bf8704c9d2b849074ea2ab6884e45984bab4de',
    'demo-repair': '71d0be49b89929fdf93c6074905dffb09cc4ea4e814bc0f53dc9576d753d0941',
    'demo-close': 'c9a3059f9d756666653de65c438895031bd90c607e57a963cc94986956c5984d',
    'demo-web-intake': '5d4abe5ce3d309ada94f814a00b949a7c895547d10215369da550e9651cdba69',
    'demo-web-check': 'dd3b828027bc70a9501a9ac0931958667f4664511a62f4d33bd829effb94bd19',
    'demo-web-repair': 'c5f8108f88c203c8cc96be42575d9cc141940ecdba86cec4a7469aab7b383e97',
    'demo-web-retest': 'b820b5ded2f398bef0f59ab62b51c46d0a4dcc3ef49e46279fb01610f5607dbc',
    'component-mapping': '506e87791b83675dec4c2e54e6b950def9144c1d667a194a72bebccd9ca00f29',
    conformance: '8aebfffa8ed9c22fa75a2e69800f73db16a7ca6b53ed02e60a14646b52736b73',
    convergence: '88f806558a64d7e46151ed3de100711ae13ff15aa34d020fd8d0c44be0f5668f',
    design: 'cb2603200e89e62c719c5c31d031ee6234572b52f2b3dffae2317ff410b513a8',
    'design-intake': 'e4d0371c1c702461dddb8f25d3f93295dc895be412324aac28d93edf39de47ae',
    'design-inventory': '55446faa95100fb42cdb4caea8f98bea68c779af06b1af70566f404e425432f8',
    'document-intake': '2bce3e0ff60252660b3514153296a55c36f9ac3e1dfaa7cdf51259845f8500d1',
    'fix-design': '1085cd2472104e4342ac0b13db4b44087004a7a6742bf15f63646806319ca93b',
    'fix-spec': 'ae226973c098930cff207afd51f304f466272abdb0d6c428eac562279ec062f1',
    implement: '2d1991614f6090ee1fa4c97c88ae67a158cf93bda49650308766fe181c2b55d8',
    implementation: '8391515ef54d176c0214f747c343f1e0edacf9b840a94e01ca450ea1106402e9',
    'implementation-spec': '56f8cd7bd70d104ae689c952446b1ba54c188c25eda4a4f9de6d7a4cb2c49637',
    intake: '3a7cdbe743b19870d809c4510a1ebdb0d9c7b49587f90f113453f46172e14933',
    'mobile-spec': '4ecd5cf51485d28136f4ac819b091242b0de8f4fc2fb6657814cd4d100356460',
    planning: 'a588b38f249f6faf6b2a4334f6467c640b38eebceba39586dafd25805082b376',
    'poc-impact-analysis': 'e722954583c0fa43793052d8ac020fc08b384f5d8a4400a96252c9c98a0021aa',
    'poc-intake': '44a071bdc3aede9203b26aa55ba77be32879f8339b008300ab0727e8ee188cd4',
    'poc-lite-act': 'ab2817ad585bac878ab86b603c79014ca84a59f274cd5325f41df477f9870f3a',
    'poc-lite-finalize': 'e4aa7e427883748714293b103bf105056a2eea47f39f13314b6d8abae6d220d1',
    'poc-lite-plan': '71d5059aa5a9a37d34722a5b540f550209b87a90dd4d5b1292389397eec54d9b',
    'poc-lite-verify': '5d3dead80d67469a1c2570fa03f8b996c9f6aa897fdc7131d182f202304156e3',
    'poc-publication-review': '9308d29f806e37c959801e44122887dd8c41eaf6b6eb85193018448f01000faf',
    'poc-test-generation': '5f60847e67d8b1b9b5c4b834d38f618b9c9da38c57d61ea1802f1a25a272810b',
    'poc-ui-exploration': 'c93727af1010872a188ee6c38a36d71e77ef3b1700a54a79525e7c8999cc15ee',
    'poc-validation': '335f9997bf3741ce5037cdf683def71d2f70337c6e5f1b9f4d2453713fcd088c',
    release: '43c9560ce805d8cd3de33a1abfd1415019afc11770a1c6fe54321de188fb0314',
    reproduction: '16fa17c5cc2287afbf1fdb193e6f06f9fe643d504fcd0b19bdefa6ea56355bde',
    requirements: '77d4d3c86d39421019846caf252ae80b8242cfcb0e5c7886116164306715f973',
    'scenario-check': '866e2fe7588272b2b7ef1132c37e8a36cecb4947419b733889a919ff5ee03f17',
    'scenario-repair': '5e4dd1839e53e3d3ca5e4cf1e27b1e40631c2e2c4a003dfe54ab9c461d22b186',
    'scenario-retest': '0c53d93ca05f0e11f733a7415870a0c20f0fe42996e8e0792cdd1d50f6316d86',
    specification: 'ac393d223b6fb0c09f9fa602a3fdb0a8eeb20dfd1025e8a2851e6fa4736df194',
    testing: '3953d7c4c106cfdde9ce7654b93b718e36cbf57618b06f4c417bdd3f6a1867c9',
    verification: '11caa9e7cf51ecb81ff24eec8effdde40cfdf60fef25f11a54cc97667ae1e3cb',
    verify: 'bd3aef3d29f9c0ce631ce533eabb905cee1a6ab20f52f8135b4aaf1b6cd6c3d4',
    'visual-verification': 'db0280a550fdeed91d02f337089ebe135912440210f773cc5b83bd76d9508b2e'
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
  ['workTypes', 'phases', 'artifactSets', 'mcpServers'].map((section) => [
    section,
    Object.freeze(Object.fromEntries(
      [...new Set([
        ...Object.keys(HISTORICAL_PACKAGED_WORKFLOW_VALUE_SHA256[section] ?? {}),
        ...Object.keys(section === 'phases' ? PHASES_BEFORE_WORLD_MODEL_REMOVAL : {}),
        ...Object.keys(CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256[section] ?? {})
      ])].sort().map((id) => [id, Object.freeze([
        ...new Set([
          ...(HISTORICAL_PACKAGED_WORKFLOW_VALUE_SHA256[section]?.[id] ?? []),
          ...(section === 'phases' && PHASES_BEFORE_WORLD_MODEL_REMOVAL[id]
            ? [PHASES_BEFORE_WORLD_MODEL_REMOVAL[id]] : []),
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
