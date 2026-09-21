import { createHash } from 'node:crypto';

/**
 * Exact content revisions shipped for repository-owned package assets.
 *
 * This is deliberately a path-scoped allowlist rather than a heuristic based on front matter,
 * file age, or similarity. Re-running initialization may replace one of these exact known package
 * revisions with the current bundled file. Current bytes are registered too (and naturally
 * produce a no-op); after the next package update they are already a proven historical revision.
 * Any repository customization—even a one-byte edit—has a different digest and is preserved.
 *
 * The entries below were derived from reviewed package history: current governed agents under
 * `templates/agents` and retired v1 role prompts under `templates/personas`. Keeping the evidence
 * here makes every initializer and configuration-authority bootstrap use the same compatibility
 * decision instead of growing ad-hoc filename checks. The release check requires every current
 * governed agent to remain registered.
 */
const HISTORICAL_PACKAGED_ASSET_SHA256 = Object.freeze({
  // Retired v1 persona prompts. They are no longer installed, but exact hashes are required to
  // prove that a v1-to-v2 migration is retiring framework bytes rather than orphaning a
  // repository-customized role prompt.
  'singularity/personas/architect.md': Object.freeze([
    '0779fa3c68059f4adc9bdd20bdfded1d3a29cc0eb095070e63371edf9bbaa925',
    '18cfa5be8b9f0b9389072ad4435d7d601227ebfeba7bdcafff7ca44924e55f9a'
  ]),
  'singularity/personas/developer.md': Object.freeze([
    '0fede0e03f9e9144e1f9aa09fb7c3a663502e0ce2e9e3f1d9ac31897e24b851a',
    'c1950a8e10495671df98e8f72a05e857d66d57b1dca9b87c901935d0e5ad54dd'
  ]),
  'singularity/personas/mobile-architect.md': Object.freeze([
    '934bfee66e6642f24788dc053078b9bc64ab8ead879375e6d371474c986d2568'
  ]),
  'singularity/personas/product-designer.md': Object.freeze([
    '8b66c3c0ec4e10dbe85e6bbfce93f8a4cea401870ef75a5714dff0237fc78e40'
  ]),
  'singularity/personas/product-owner.md': Object.freeze([
    '250897f83c2e9dc294464c5c785e31dbdb9c14210e72dbded5c3a8971b467b55',
    '196833293fa54fec4e7aa9f88d5e68ae2deed0c6c1100c2c88bd91d87d93cee0'
  ]),
  'singularity/personas/qa.md': Object.freeze([
    '9d2c51b9f8359f69fb07fd5aa05c1e9442c7443d2b7c9bcc15cb3a00819746f0',
    '4d48b8b624b4463517ba5ece9596aa471890358742ed9497c0819b08c7833580'
  ]),
  // Retired provider maps used the same exact-byte replacement rule before the registry was
  // shared with initialization. Keep them here so every configuration upgrade has one authority.
  'singularity/modelTiers.yml': Object.freeze([
    '9c829dea6676d1ad6066197a582125ec049a7e42c62300736ec83cb2ba563449',
    '9a6b011b1033b205981d7dd1e87a215a3de53f81c2e422a85d9f8d6438d36faf',
    '68f5da2150926169e8316944b9f11a33271d46127abdadcd88a233d2b4e2860a'
  ]),
  // Reviewed predecessors for package-managed templates and prompts. Current revisions are added
  // to the complete registry below; these entries prove upgrades from real released bytes without
  // treating a filename, baseline receipt, or similar-looking content as framework ownership.
  'singularity/templates/common/implementation.md': Object.freeze([
    '5d0478b18c8fd14221e14c68e6238b909bccd6802a70262c416005354716c62c'
  ]),
  'singularity/prompts/copilot-planning.md': Object.freeze([
    'd4a47524fb1563faa4a07d63bec271a0c8e3361689fdf75e1d99ea78851af9b6'
  ]),
  '.github/agents/architect.agent.md': Object.freeze([
    '0c8630b4f5d3bf2bbdabc4f67f4619caa7e537a566111cef40440c6c7abce016',
    '188198ceb7da73ef10814aaea2426dea127442f199fa16939f84a95415547ee5',
    '28dceea24f5990cb48decf09cff11b29071febdf58a64f9253a09ec19e99d58b',
    '308eaf5824f2a2d431d7bbbf527947087508b408e866584c15d6365db8d1c23c',
    '30dc4a4002ddfabdfdb573ad375c6a704bf7705caf9f7b93fdbc08b27238de83',
    '5ef94064b3e150648c5b8f2220475588575b8f8d8fd1e2c78004950a59798987',
    'c17746841c5afad787e9a33c8a97aa6de15bf44a798d541f1d4c61659485d872',
    'c45b741bd7e5700fa1f4fde5447ee073460cce233c9c60fca4c90a0c2966d271',
    'd7aa40fde49e3111836cc478b20d9cef03bb403512d48f8fee8b620c6f2af878',
    'da4f136ae11c0cb459500d4008a5629797f168ec4df87ba807da31c12a59c467'
  ]),
  '.github/agents/developer.agent.md': Object.freeze([
    '08a26b9ab8dfed985a6bce5d470c1cb1732f8546a1c3c49360005aa42a728105',
    '274adbcae64ecb9896bd9f53ef8c21a3109918fb7015496e0a8d8b5f57cc143b',
    '2e3911baaf60b85330b3dd3eb251bb2dc2c86b10851a16d826452a51064ccb73',
    '669b82f0c0ddf8947dbccda1fd9f91ad2973e314e7a60d35012b94e103a3d72b',
    '73ea37256ad3bd2c1b5cd176f99803bc66de49e6ace6063c52430e50e9b6ac16',
    '79b21b6d470b38c8b0099d385e3da9902a5e01012c7f835c60c412cb244b0c92',
    '8a65f1466aae11c85735eeae0060a390a3ca7c02be1e64187a811e4e2cc6c7bf',
    'b3ecdcba0c9ebe4cb31eb30232471111822392bf960aa6a67ac92178691dcaf5',
    'b51bc33389e5b442683299b5c5b93a89866c31cc36f19adf4b615d61e20491b2',
    'b7bf46ff7b398ad4ede9c1747229e168e421cbd00b4191c57a4ccc39f7ce4a53',
    'c84b47c5353c6db58f0ecc49fe7547254804a4679882d666276344fa9271f149',
    'edfba1ce014ba9a5cf379303efa3841eb4345dd1602f2b2566c8e5001d4c99d1'
  ]),
  '.github/agents/mobile-architect.agent.md': Object.freeze([
    '1cc19f6ab0b71a6c3296e8993c3610570c9ccfe82dc30308e5393e7e36f5ac33',
    '22e5fe1e93ff229de7bcc51b70078d8d4f48b925c0ef802a8ab20d1127883128',
    '25c97dee212791eaeff956b0b32c756272c1e0b9a8bf94819a4bb70c81956a00',
    '41df3ec017a210fd210b351eb5bf99ed278b3f7cdee27073fd93522488393def',
    '74dc5471afefcea6dee62fb5fc710ef019c809e51db3ab7eb203f238536fbf48',
    '830219deadfb61f600397ae9c63402b7954fbc4c21f4a893058a4a138df24903',
    '8304d4312924dc1d261f54d0f898ad3a3b4819091f334fb037e5b92aa91be334',
    'a4424d77b4bef04efbc957706fbaba3f577c6b4371e41cd8f94e4e465b516851',
    'afebe77fff23c5493852c2898a39410d115cae1f346256cbffcda9dd103bcf2b',
    'c0d882e1b6a6a946e4573756aa156e4ca918b578634baa35e6fccb74a595b698'
  ]),
  '.github/agents/poc-analyst.agent.md': Object.freeze([
    '1d4e071363256e214a58ab810819218cff8f4d288d571487eb6f18d2bca8b1d2',
    '23f6c7215e1a84e3ce249515e504e74b374dbc59177baf00a1f5b611b832310a',
    '582f046a0912e9d7cd2df1a94cb411d1f24b313b28b91795529e7be99f355d8d',
    '604d35e01fb207d693b8067bfa449c8c325b3493a3fb6dc49f5522156009fbe4',
    '7b7690a834615919f4a4417a60783359965a848f8775dfa67acadb818684411d',
    'a5e8b6d7bd4daaa7eed58f5b4d5aec4985f53e8cc6b79f8b353f31a59c9b2099',
    'b2911fb7034dddec1d44266f83146a0460dc158a3efb6938cdefda2ae0d96086'
  ]),
  '.github/agents/poc-automation.agent.md': Object.freeze([
    '0b6f0a8866f388767a216438b5bc5280615589fc0da50fd6288cf9388a902ef3',
    '0ed8eae43d116bbe10745d851180d6043a563568635359087da424d67e19aee1',
    '23adcbd69ceef94dba9fc035273cbfa2d878bd72c33c9c3a89ebd1d085a39cd1',
    '293e8c404b05f4a2ba4465bbed0be5b828ae367df6e6263c7255235948e6bee2',
    '912dd045895707e4b54b9fe36955781879b735c0af93703a9304ba3533d0e17d',
    'a52c4b3f95ec96670c342b144867645b63cda4e08c7ca45f570fcd2906152143',
    'bda6cbbec61b28ce003de64e7c9793474437e1b5d736575da9af74c03a12c57f',
    'c4ae69d6903cd299dd58af76e54e0d163a912a0e651b3b6d807732b018f03bb7',
    'd73d47b80a35f88d74fb9ea69cb2b2ed5038da3c2692a9626f1141fcfe1fde40',
    'ec5709c720d979d389ebb20cb73977f0efc485d87781b62135857c622c625a7c'
  ]),
  '.github/agents/poc-explorer.agent.md': Object.freeze([
    '5b863a56b6d645a71c858afd8edd29b6f7cbc60b441d4b3b2df513826611ee18',
    '6c471ac9d6bf14f865e73cd1a39a3cef635e3bdc7c4f455d182ae9b0845b7277',
    '8c983c14434e88e8c780874cef06f3d8bc0bd1438447bbbc7a5832050d2dc786',
    '91ee8c5b1df5431f5a72c4d010ffaef470fe088e8918ffda9d0a607780acf65f',
    'b326394f315cb5bbe67aef6f4c3500687b8753dff64fd7a92446558bbd69f498',
    'bdf2798d35072830cb977398148cd1f57c24d73753b418c1e2d2d8bfd96558ba',
    'd0fa8355f9b7bb8924427a8a000c23d65c99062cef507eeffbe6ef3862858c08',
    'e20eb9f019128dce8d1a92842e19b368b012965c1abc5322ae22e57e223abcb8'
  ]),
  '.github/agents/poc-lite-implementer.agent.md': Object.freeze([
    '8fa2344494618a1200b987aec80600b8d05cde24c3dee57e7ef6934fdd42e064'
  ]),
  '.github/agents/poc-lite-planner.agent.md': Object.freeze([
    '85b821ac88fb52eb7972f1026f605f04144fb27df5afc2e42fc0c06212562a9b'
  ]),
  '.github/agents/poc-lite-verifier.agent.md': Object.freeze([
    'd2a01fd1beebae0b2399d0a2908d4ac0db5ad8cbc803020f40697914a2b7ee60'
  ]),
  '.github/agents/poc-test-developer.agent.md': Object.freeze([
    '20a6a09cc14dac8fd7cb461d412fe708eeaeaf3be55c3787212f4a09bed7e17d',
    '4c82f12e6642c42e60ef6b0e4a19b9c37b70a73c2089b8dfd2c525858d7a4681',
    'c0ac831ab7d1131c361528624e52a06066bbdc2da1ea726e7d089d06c6b37dae',
    'c40ca16bd75bf3d201e4b324500a4623af322e707f25c5de46e64aebc49f4829',
    'ca76f451cc8e91ef327fdcee6fe8c0e0c4338960cc34595ebf8ae2ea9de3fae8',
    'dc91d663a83017267c7366a3ac3e903e7b4fd803af2284b9c7d252bf61c2c8a0'
  ]),
  '.github/agents/poc-validator.agent.md': Object.freeze([
    '083dd2ee6f941c5f873f9b42d4ec50faf450cb703fd55951dd55244d1bc1d82e',
    '0d391149188a912560efb6e5d750c06c63c92d8442c474dfbb6a036c7dbfd7e5',
    '28e7ed2f6291a837aaa251a2dd7cf3c2575fca60bfa27bf630f45295a59dc37c',
    '43142777edc499d637bf0ba0371be7e43be32f1fff8964da1b60fd2494db5c34',
    '904954066c83b071fc03c8077733027bb5741b8f870c869e8754a896eeca8714',
    '92a918b0d033899e7f6f0a3c28663b016ba781a005e736ef926023f7be0c625d',
    'a7f8cbf15a2474f2bf4a6f959a95a49917f7a1df3b96b9cf0222ab2a3f8fb4c0',
    'c4b60bf225a36ed4e44d00cfa6c28442eaf4ccc212dfdc0cc7ffdaf33ada0328'
  ]),
  '.github/agents/product-designer.agent.md': Object.freeze([
    '1103db033c0acf04448e1794c40296d50c0794c6860ff5be0b11b258998e230e',
    '2a347736d3ffa58635617b47721c4306d4cb3979af9101a08cb0604b03fe37ec',
    '330f43cec8f05c22cef3fcec99be31daab818b36c2e7dabd25293c95b05acea4',
    '3857dda1a490010c4cba23cbdc0405f6e9fa7e371d904a78b96d1e3130a7604c',
    '644bc2c3ef3a71903eec8a4a4159e158462754991cf490f251a0c956e4209c7a',
    '90a2cf69c295d0062c95a42adb7ff6f40601286641776f077f19922efeeea864',
    'b08909068f12c3caa816fa6fab8855428e40902797a1e78316ff38a367574f16',
    'b360a859d47caf21908fc07bf54d934550e1873158114e2977154e8476135791',
    'd059499cdb40b4d2cddfbfd0588dc2b2ecda51d18d56be3f3a4df8c53c7ec088',
    'd82dd98781ec5ea5895892ec046106aa58dab5575e17cdaf7425fcbe4fddd6e2',
    'd865c816c41be1723bd2d3ef1e769f02821e2a45a75120119f50606a7a3d1fee',
    'e71a3a77592c53010b2de7f107d64f8e401514215e891e37af9660a7ef8fc945'
  ]),
  '.github/agents/product-owner.agent.md': Object.freeze([
    '491241469786c77bf5f99384fdb7f9c0da7abf637fb5e8fc531992a6168f0027',
    '54c7240d0b81c04e47c453fd19a29caf358c07d3d36a93b84ff84541e7f9aeb0',
    '5e134b783407788f9c5f42f20bbe8b43fef252a4105f04aa18868a611a2922fd',
    '72bc0c8aada5447e2b8ce1d0450435adb1060bf061e1aae298e6e7ba8cf863ac',
    '86fc702216b2e84cd7ed65ff7ea05b569af345180e9cac6ac14fa5d8bf8526ce',
    'bf34f8e00613be9f03f23b518815cf886fb903c3eba7e5670106bbaca197e4c4',
    'd489c05a63d6e37482f6b8973881898640f72de3739db8e207470a66f2f40b63',
    'dfd54a579bb1abc03c4e2d56f904f4e6d8da39b7564c3dac7bb5d2f20e289a97',
    'ea838bed87ce9d24400e1aaf0423cb829ab5334b6bddd728fa1c074c8ae2e152',
    'f6d6bb18fac60c089b7867453ee4e84759a294a9f42a48ae52f6802f86fb78a0',
    'fcd6757dbc695423e0df1a9bd906e88569c7e000cd84c35f1a1b532bfcd822e2'
  ]),
  '.github/agents/qa.agent.md': Object.freeze([
    '3af12e12be861a865ee17cf3348990798bdc3a89e1263e1abfe7a46c2a10df8a',
    '3c0c9560c422fc616b391277b38d409b004864449b1a9cf4aa06bd5e302233e5',
    '452100331664da07d932209875c45e725ee92f080e541909cd595d3d9bc5cf94',
    '5c8131eb79b2cade08aadb05794e7647d22a717c6e966bd11050ee060a050989',
    '572292f0c00d56aa2a87af1c41f0d3eb2c75d7e09c04b464af5e5663eee32842',
    '66093cbc27bc036cb482a4291db18b5a7cfbd8ec368aa105dce2ce00932bc9d4',
    '6a5f1ed504e6acfe0990c59e977de0f7bc4fa9afbc1f578466f723f238e342ee',
    '88b4c08c6b84cfb03a90fcdb1cf5acd13ab00b7aba8366559cb080b038a8eb52',
    'a3e75edde4eda82ce356992295b40b67d4032404759d91f35d500c992529c88a',
    'b373c066ef3f0d1e5bcf0e598d6fd5e6022e375fc5fcd28e8c9c618de5e73cfe',
    'd9c946f4065ce087cb0c8ee2e47231a2bc2a308dee97a991297b4b2032ddd65a',
    'e4b50c0b7fa8c2cc84d9cfd5794a9406d91216a024e4b44200b276032d1822ad',
    'e87beaaad02bacff42a0fe75165d46037fc596312fc5085e5ffa8a88b3a6da57',
    'fb292e36fbcf2d741e2493a4677a589c1d16db458c44489e02534b1e56252209'
  ])
});

/** Current release digests, kept separate so a known current file is never offered as repairable. */
export const CURRENT_PACKAGED_ASSET_SHA256 = Object.freeze({
  '.github/agents/architect.agent.md': 'c17746841c5afad787e9a33c8a97aa6de15bf44a798d541f1d4c61659485d872',
  '.github/agents/developer.agent.md': 'edfba1ce014ba9a5cf379303efa3841eb4345dd1602f2b2566c8e5001d4c99d1',
  '.github/agents/mobile-architect.agent.md': '830219deadfb61f600397ae9c63402b7954fbc4c21f4a893058a4a138df24903',
  '.github/agents/poc-analyst.agent.md': '7b7690a834615919f4a4417a60783359965a848f8775dfa67acadb818684411d',
  '.github/agents/poc-automation.agent.md': 'ec5709c720d979d389ebb20cb73977f0efc485d87781b62135857c622c625a7c',
  '.github/agents/poc-explorer.agent.md': '6c471ac9d6bf14f865e73cd1a39a3cef635e3bdc7c4f455d182ae9b0845b7277',
  '.github/agents/poc-lite-implementer.agent.md': '8fa2344494618a1200b987aec80600b8d05cde24c3dee57e7ef6934fdd42e064',
  '.github/agents/poc-lite-planner.agent.md': '85b821ac88fb52eb7972f1026f605f04144fb27df5afc2e42fc0c06212562a9b',
  '.github/agents/poc-lite-verifier.agent.md': 'd2a01fd1beebae0b2399d0a2908d4ac0db5ad8cbc803020f40697914a2b7ee60',
  '.github/agents/poc-test-developer.agent.md': '4c82f12e6642c42e60ef6b0e4a19b9c37b70a73c2089b8dfd2c525858d7a4681',
  '.github/agents/poc-validator.agent.md': '904954066c83b071fc03c8077733027bb5741b8f870c869e8754a896eeca8714',
  '.github/agents/product-designer.agent.md': 'b08909068f12c3caa816fa6fab8855428e40902797a1e78316ff38a367574f16',
  '.github/agents/product-owner.agent.md': '86fc702216b2e84cd7ed65ff7ea05b569af345180e9cac6ac14fa5d8bf8526ce',
  '.github/agents/qa.agent.md': 'e4b50c0b7fa8c2cc84d9cfd5794a9406d91216a024e4b44200b276032d1822ad',
  'singularity/agent-mappings.yml': '1b39a4f4caa3242749889a291e2259a361c815712bd762abde3db3cbe9f8a688',
  'singularity/impact.yml': 'e91000c4f19ba8f8c08812ebea1d3e825919f5b31dadd1f3e22f1749e3b05313',
  'singularity/modelTiers.yml': '9c829dea6676d1ad6066197a582125ec049a7e42c62300736ec83cb2ba563449',
  'singularity/prompts/copilot-planning.md': '4128acc6930949e4ba1e50e8b8c7c4f7beb23f4361c2e8428475b081712b77db',
  'singularity/prompts/worldmodel-builder.md': 'cd93d41ccc98e4ccc09550c60cc79ad6c5a6004d7f8ea66cec596640ab73ffb4',
  'singularity/templates/benchmark/conformance.md': '41484584d35ff0c2e214e8f9592b105bba95bc36b38dba919754b54380851a2b',
  'singularity/templates/benchmark/design.md': '92ba1c0684e20d201a7bfa1c9ae7b61a87001ca0c724ff0a61af2d387b23f9ba',
  'singularity/templates/benchmark/implementation.md': 'e25ab3d9104c4ddaef541191d544ea032c35f551b9538ad77a38628ca1a58db6',
  'singularity/templates/benchmark/intake.md': '49107281e2e461ede0e000edb51bf9f22aec85ddc84acbd1781680076f795f5c',
  'singularity/templates/benchmark/testing.md': 'a9338f04dbe1be3ad988c331f9b45bab335a4661fb367f2c4f110609049fb9a8',
  'singularity/templates/bugfix/fix-design.md': 'cee7774777fd55a3740ebd9f2cafd100702d52617ae307f80e35764229c7867e',
  'singularity/templates/bugfix/fix-spec.md': 'c1bbc5602eded66e1387f3fa95a835d7bb49f05a2fd813b193c0cada7c420c87',
  'singularity/templates/bugfix/intake.md': 'c0aa89555e400e9c78c782021b1928175607f32ad20773c70fae04b28ced320c',
  'singularity/templates/bugfix/reproduction.md': '083e0361f6ffe9e84905b21558554c8335ab1a036719cb37f104e03f255f3567',
  'singularity/templates/chore/intake.md': 'd4632690fa411f3926eee1bfd474f5907aae5efdd31313576acdac04e8934441',
  'singularity/templates/classic-delivery/code-checking.md': '795636436d0542eedc116e5789f019c6ca675100176e78e29b08c92a3942addd',
  'singularity/templates/classic-delivery/intake.md': 'd91d55500e7dbc30a388633bce723623157619bca0bbc9bbaf8e64dfd85308a8',
  'singularity/templates/classic-delivery/testing.md': 'd84b65e54ff4210a7fab6cc1af3a2ea45bbba61fbee383a1ef985f31848ff177',
  'singularity/templates/common/conformance.md': 'dcb95249d8fef0dcdb87a6f012f09c481a47813e50f4e8dd96be207c81c15ada',
  'singularity/templates/common/implementation.md': '61cd7cba79a0dd2914a25b53496b8bd9c575c36219597d65b8ec10010e801d9c',
  'singularity/templates/common/intake.md': 'e16cd8b47f472973823a1a53294c77ac6551285c4df75e916c739611c3bc1d23',
  'singularity/templates/common/verification.md': '46a93cccc0edf7b3d878f05f212ed68350c26cedb33d96b3c447ac38bde20c40',
  'singularity/templates/feature/design.md': '8b7455f464a7025efa92942c272a04e3c0a3ab2a4d3eb438703cc14e230bc856',
  'singularity/templates/feature/implementation-spec.md': 'adc2b93c3cf849c4b335237cea68c05fc2fdeb4ef087a8b4236493be574a0a37',
  'singularity/templates/feature/intake.md': 'eb53814f46f12ea3d93d1629164bd7ff22a3a54feceff7f7dd55670caeb5dbab',
  'singularity/templates/feature/requirements.md': '32016db8ed6fadd6596e7dc702647cff95cdee1a203b38395d7ba5626dd8134e',
  'singularity/templates/figma-mobile/component-mapping.md': 'cdea8a1e3defa73ade72bdaaac162ecd9b8b43817aa319d7e712e2de2eb296a3',
  'singularity/templates/figma-mobile/conformance.md': 'b3f2c36f238e847fafb1e1de2647f57d9516f1cac8b71d179333985d63340a83',
  'singularity/templates/figma-mobile/design-intake.md': 'f84db46cdf86cf8c4da4de0062d7150466d5dd291baf6495bd9523affa9a6453',
  'singularity/templates/figma-mobile/design-inventory.md': '822ea61a75a25ec5a6b42dd887c842d5126233b36f7f0fc875402f9a43125079',
  'singularity/templates/figma-mobile/implementation.md': '69b5b75886dcc41da4e3063c7ceb6ff805251f98dd40ee41b2bf5de660dc74da',
  'singularity/templates/figma-mobile/mobile-spec.md': '18c583c10c597c595cd0be9c11ddf16e92a0b85147efcd4fd3fb1a9bbd96fc44',
  'singularity/templates/figma-mobile/visual-verification.md': 'aca2f864d6cc1b5321e466f80d0751ab4874049271b2fabab03dde7b0ec0e835',
  'singularity/templates/initiatives/adr-log.md': '4ece55ac194e15395cbc331d382d6464f76e013b33576050895092a5dcebce12',
  'singularity/templates/initiatives/business-case.md': '155faec79961574f8dd12556f0874ec8bb396f5a546ca792b2ab41dc34aa6a17',
  'singularity/templates/initiatives/cicd-readiness.md': '98222239a8e316ff1413f827f1fe400d90345bb0759db5d06fe49f859e2aa754',
  'singularity/templates/initiatives/compliance-assessment.md': '88645356dc868b46a78dabc50f2605b28e0ed0d9b78549e7cf9fef6536ea2296',
  'singularity/templates/initiatives/data-readiness.md': '9b39c24e75f253e461fdf45150378a62599ba5782fb1a1721b1b6f66ba9b2dfe',
  'singularity/templates/initiatives/data-source-decision.md': '49b76f3f576c6660696a6504e7bfdd78737089c26b540be5ea7f638ea800189c',
  'singularity/templates/initiatives/dependency-matrix.md': '890fef7b2cae6c11927137161755c4a9cfba8f13fdd7aca73b58ba8ef5ff1b7e',
  'singularity/templates/initiatives/deployment-record.md': '1898365f596234fa78fd9b6330c9cc5e7ed50be566b998e7f8ec8f76f294db85',
  'singularity/templates/initiatives/design-specification.md': '341c2ebad1e5945a011906e451c2b7290fc806e35e6a531bbc39a9b87bf11a5e',
  'singularity/templates/initiatives/epic-record.yml': '9ca4bdb695a7cd07633746cbe8245a2e170315e09b3dd10a252684a25671ad94',
  'singularity/templates/initiatives/epic/impact-analysis.yml': '25a9ebf19c65ea0144ff23a0c2222380f0e61ef9c97c0b3cd4fde66ab9c46ca2',
  'singularity/templates/initiatives/epic/jira-write-plan.yml': '176c8c177d77e61df465472bdb5b9bfb67a9a3183e13e4704aafa1f4931e48e9',
  'singularity/templates/initiatives/epic/materialization-report.md': '18bdd184358ac5f1f08f4e0edda9e09bab7dab8b8dcbfe7a65a2e4196e99001c',
  'singularity/templates/initiatives/epic/parent-spec.md': '4c80b3cb91962fd1b1fe64f01bd7dc4b0ed14ec7fb889750cabf1522eaabfa72',
  'singularity/templates/initiatives/epic/repository-map.yml': 'd87a27fb71918827adbb9cbbcbc58efcf9e00689e24154215c021e217cb75b6b',
  'singularity/templates/initiatives/epic/requirements-traceability.yml': '672a8ccb13f2945e9043e325f7fe0538bddfe8a43d3bf07864bee7937b680b73',
  'singularity/templates/initiatives/epic/requirements.md': '174d57ca16c5b43a23c6292873c683335f9fb08c6efd6d0a7bf6e6594aa5ec0b',
  'singularity/templates/initiatives/epic/story-plan.yml': '9ff2b979d06de8302c36ef0e1898c1c74df6f0dd92df64c1b68accdf360b555f',
  'singularity/templates/initiatives/epic/story-spec-index.yml': '3aeff575724e8b53fd1bf7cb0a01a41280c99ee714920b637c317aaf5cf88526',
  'singularity/templates/initiatives/epic/story-spec.md': 'ee2791700162ce5b843ce9458bd8e2b6580b97d2e6db4343fafc5cc64ec9bfe4',
  'singularity/templates/initiatives/eta-register.md': 'adeda18823f2d52d82f17c5c029bd883a504205cf8757f2a7ee5237e5d1cd109',
  'singularity/templates/initiatives/feasibility-report.md': '10fe5879b55d78b9a06b24589328fb2517eb0defd4f6e465b23ca0f6f833b63b',
  'singularity/templates/initiatives/functional-tests.md': '760e46dd617e449ff8993dad3a98ce8c4e95e928dbf63c1b00017bff1d3ebdf3',
  'singularity/templates/initiatives/generic-output.md': '67e01f4cc8cfd624400128a7f16e50ab62a98d52a920b0f5e9a0fcea2607759a',
  'singularity/templates/initiatives/generic-output.yml': '6d57e9ed847259d3671f61f737eaad7604c2952cb5268da25f701b1facffcdd4',
  'singularity/templates/initiatives/implementation-index.md': '8d3c8cdf27fe2aebf9991858836fc3bb7b37d902afa5638616c67a9c9961dca0',
  'singularity/templates/initiatives/initiative-conformance.md': 'd5270e19131d7c2a1bdb6d447a1ed04017f80ba77ad3703f35c5462ee67a2801',
  'singularity/templates/initiatives/initiative-scope.md': '142478e091855e712667f23038ffd40a92e4f86b0e665427f27361d74b1ab489',
  'singularity/templates/initiatives/intake-record.md': '1dbd17ccf123ef632b1248963cc1ad36786b96efa8879278322e77aecc2eeabb',
  'singularity/templates/initiatives/interface-contract.md': 'fb047de3b81b417eb257862840e7cd9b07d533d70711301bf904272124954053',
  'singularity/templates/initiatives/measurement-plan.md': 'dac7671ee00e4207d5b25a520935fe536767b66219b21cf405872affb0d16187',
  'singularity/templates/initiatives/nfr-assessment.md': 'fdbdd138b0a6c1d3ae03acf1a624c42aa074c802a5c25dc8c36ceadb8db3e46a',
  'singularity/templates/initiatives/nfr-specification.md': 'b98bb5b743576d4cc55f1f508b5d7489a9a85eee72c9af4f93ce71b396fc454c',
  'singularity/templates/initiatives/observability-handoff.md': '41787345e0e77b79e0d3ff5878d3d61f018e42cf65d66681d14fdfa014e2750a',
  'singularity/templates/initiatives/operational-readiness.md': 'd8890590723c5cdff0ffe5225f5e88e8d2d5cde8f7b3805e3568393162ff5c31',
  'singularity/templates/initiatives/opportunity-brief.md': '1896ad72afd98908b599e3ae5d81de6843df2601e91b6bd4e813a0768dff7b6a',
  'singularity/templates/initiatives/poc-results.md': '40aba41fdfc6b2f4c748976082801e85e1bef84b80fe300980cc50fa3d0c89f7',
  'singularity/templates/initiatives/prfaq.md': 'b2dcba973be8992f52373720ba5af959b233e3a6059bfa07e26a9797a23cc22f',
  'singularity/templates/initiatives/product-roadmap.md': '34a3df88bd97e0637cab02564f54ff98cccc776d5267ad6d85a3d063849e6cd1',
  'singularity/templates/initiatives/production-learning.md': '5e090b0e8a4821698af7b86052d43c970e009b8c64bcb3ddfb8b5ac8bf57c50f',
  'singularity/templates/initiatives/production-validation.md': '8ce5dd20813d422778c1921a7658793b0b63640fe2b00af3ecca1a15cc08f56f',
  'singularity/templates/initiatives/release-scope.md': '56ef6617316bbbe052a595dafed210f5acf854d7426cb9420e89e1269038552d',
  'singularity/templates/initiatives/requirement-impact.md': 'f3afdcc90c5bd4e7d8c8218070b6bdac58f22d5dd787d288b515495e883dd1ff',
  'singularity/templates/initiatives/sequencing-plan.md': '832d7d8e9820482b7263b87e9305a98037bd971e4a34a5c65e7d8c5cd5fd30b3',
  'singularity/templates/initiatives/service-blueprint.md': '36424028305ca3a95f355249783090907e9fab5620eed93a9537b777af33ccbf',
  'singularity/templates/initiatives/solution-architecture.md': '699d6646a25f65bb7967081dced900e3c5235e16613089e54bb002f184e67862',
  'singularity/templates/initiatives/solution-validation.md': '9e025f84f9ebdcc5a56d1a0ae5aa044e5e0f04ec3857ba72c18afee2a209052a',
  'singularity/templates/initiatives/stakeholder-raci.md': '7aa9d81064f4e41f5756ab2d0df1e1777c7b83530ff54f994823c359292f20c7',
  'singularity/templates/initiatives/technical-poc-results.md': '7fbe8d0159e55a79548d6a56cbb5e1990086c5abb821735c3a197bb95f9922de',
  'singularity/templates/initiatives/test-attestation.md': '28fe58500e6d21aa1816494ce8ef6c15b16c30da9d5f04c30f8c1f97554be822',
  'singularity/templates/initiatives/test-data-inventory.md': '3377bd930d736890c16ecff4c1f1ec81ee83636e609aa61e95d29a5449793419',
  'singularity/templates/initiatives/ux-concept.md': 'd12e90b0412fcf41cf07fec6bcfe8c83d80949fc01fec2973d23a24a62e73b89',
  'singularity/templates/poc-lite/act.md': 'f9c3c015c593a51b7d3fd11ba5ec9fc104eaf00f45e2c78ea50a9b78d061c383',
  'singularity/templates/poc-lite/finalize.md': '6e46b121db6e48206916719e66b927c19e3db86bb829c661bff89db74e814940',
  'singularity/templates/poc-lite/plan.md': 'cac46909b752b8d14cb4bab3399dd9d57da540e5ba443f171b4c1fb4695882c6',
  'singularity/templates/poc-lite/verify.md': 'c31624345a1b3803f1cfe267b670e570e1ad1ae3742e88898d123f962b913a58',
  'singularity/templates/poc-workflow/impact-analysis.md': '16b58133b53c74c225f9e0a10b36301678d3ae5cd1a2686f23d1cbe414ec6c93',
  'singularity/templates/poc-workflow/intake.md': '511fa3a7c281bf8a4c84977668478392b5f73d14273d3149db6392eeba3b805d',
  'singularity/templates/poc-workflow/publication-review.md': 'e5d0e59595e5dd01899883adf781a728bdc6636a07efe4290b57c55b808288d1',
  'singularity/templates/poc-workflow/test-generation.md': '6fa0c17056fe263eb9f47699a84a0759a899b8e67c35a3d53df8961f1ca59b25',
  'singularity/templates/poc-workflow/ui-exploration.md': '14d107cc9778b9e737327e363e84e60975076a7003016d0798e92496ef1d61f5',
  'singularity/templates/poc-workflow/validation.md': 'b1d121afbd49c09538d221cbac60b352a21f7eb7699bc4cba08d35b88ba47fb6',
  'singularity/templates/quick-fix/implement.md': 'dff093133a1be4c93115cfbbb0d994c8ce391fc19279caee30b441ec27a05c0a',
  'singularity/templates/quick-fix/verify.md': 'a21900d99d044d35de501f0e43888a8a3ebcfe860e702a5d1b3eec61fdd06f27',
  'singularity/templates/spec-code-test-loop/conformance.md': '8e3f2c7b86b934d12e9929f31de6d1e6545a388592095a5147b4ab957e4389d7',
  'singularity/templates/spec-code-test-loop/specification.md': '4a487088d8275fc54afcb7932c18a4fb04774e85309b26b3ae72618ce9762bc6',
  'singularity/templates/spec-code-test-loop/testing.md': 'eef65b164a45b3df7843d76ef071e9d9932304ec9861c8ed19c646db105f9284',
  'singularity/templates/spec-driven/convergence.md': 'eb257477afca0229ed858875499736c57498015aaee0a527b714356819a9dde2',
  'singularity/templates/spec-driven/plan.md': 'e8af98405a723a55c572c705e34a5b2fc05a11b3efe632e169ba6becf6c1a04f',
  'singularity/templates/spec-driven/release.md': 'ce6e1d1995c68158f4209063b3cb954eceab8576e1c8db76bfaed27a805a8908',
  'singularity/templates/spec-driven/spec.md': '27424a624b1dab57323fd7482ac62708bd42d11ba42e41c102f94e15182fe485'
});

/** Every exact package revision accepted as framework provenance, keyed by repository path. */
export const KNOWN_PACKAGED_ASSET_SHA256 = Object.freeze(Object.fromEntries(
  [...new Set([
    ...Object.keys(HISTORICAL_PACKAGED_ASSET_SHA256),
    ...Object.keys(CURRENT_PACKAGED_ASSET_SHA256)
  ])].sort().map((relative) => [relative, Object.freeze([
    ...new Set([
      ...(HISTORICAL_PACKAGED_ASSET_SHA256[relative] ?? []),
      ...(CURRENT_PACKAGED_ASSET_SHA256[relative]
        ? [CURRENT_PACKAGED_ASSET_SHA256[relative]] : [])
    ])
  ])])
));

// Compatibility alias for callers that only need the path set. Hash classification below still
// distinguishes current from genuinely retired revisions.
export const RETIRED_PACKAGED_ASSET_SHA256 = KNOWN_PACKAGED_ASSET_SHA256;

function normalizedRepositoryPath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\/+/, '');
}

/**
 * Map an installed artifact-template path back to its path-scoped package identity.
 *
 * Repositories may configure `templatesRoot`; the package bytes do not change identity merely
 * because they were installed below that explicitly validated root. Fixed prompts, agent files,
 * and policy YAML remain exact-path scoped. Callers must pass the repository's already-validated
 * templates root—no suffix or filename heuristic is used when it is absent.
 */
export function packagedAssetRegistryPath(relativePath, {
  templatesRoot = 'singularity/templates'
} = {}) {
  const relative = normalizedRepositoryPath(relativePath);
  const configuredRoot = normalizedRepositoryPath(templatesRoot).replace(/\/+$/u, '');
  if (!configuredRoot || (relative !== configuredRoot
      && !relative.startsWith(`${configuredRoot}/`))) return relative;
  const suffix = relative.slice(configuredRoot.length).replace(/^\/+/, '');
  return suffix ? `singularity/templates/${suffix}` : 'singularity/templates';
}

export function packagedAssetSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hasRetiredPackagedAssetHistory(relativePath, options = {}) {
  const relative = packagedAssetRegistryPath(relativePath, options);
  const current = CURRENT_PACKAGED_ASSET_SHA256[relative];
  return Boolean(KNOWN_PACKAGED_ASSET_SHA256[relative]?.some((digest) => digest !== current));
}

export function isKnownPackagedAssetHash(relativePath, sha256, options = {}) {
  const revisions = KNOWN_PACKAGED_ASSET_SHA256[packagedAssetRegistryPath(relativePath, options)];
  return Boolean(revisions?.includes(String(sha256 ?? '').toLowerCase()));
}

export function isCurrentPackagedAssetHash(relativePath, sha256, options = {}) {
  return CURRENT_PACKAGED_ASSET_SHA256[packagedAssetRegistryPath(relativePath, options)]
    === String(sha256 ?? '').toLowerCase();
}

export function isRetiredPackagedAssetHash(relativePath, sha256, options = {}) {
  return isKnownPackagedAssetHash(relativePath, sha256, options)
    && !isCurrentPackagedAssetHash(relativePath, sha256, options);
}

export function isRetiredPackagedAsset(relativePath, bytes, options = {}) {
  return isRetiredPackagedAssetHash(relativePath, packagedAssetSha256(bytes), options);
}
