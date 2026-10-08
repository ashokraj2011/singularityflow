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
  'singularity/templates/initiatives/epic/repository-map.yml': Object.freeze([
    'd87a27fb71918827adbb9cbbcbc58efcf9e00689e24154215c021e217cb75b6b'
  ]),
  '.github/agents/demo-web-analyst.agent.md': Object.freeze(['4bf52173acab7a379c75157795e1a37ff5deb8154dd88894d60f0e4fde857e3f']),
  '.github/agents/demo-web-developer.agent.md': Object.freeze(['1f6b44af2a0b2e15c8f8c39fd44812055baeda5fdb9faf6073b4aab1ee03684f']),
  '.github/agents/demo-web-tester.agent.md': Object.freeze(['33cd834531b9bada674063a86c6d0569e4ec0103926ae044b115544e9f6a480c']),
  '.github/agents/document-analyst.agent.md': Object.freeze(['d889e7a7ea57b049a0a1a97f778cfbcc66d22f8a2f1768ee36b2e87849b5431c']),
  '.github/agents/scenario-developer.agent.md': Object.freeze(['3e17401a1e2aaa531456145dfa765445cc937e210ede38fad08d89c10185133b']),
  '.github/agents/scenario-tester.agent.md': Object.freeze(['075a2f13c8867245d11729dc9c0b304a40683d88424c8bed9587d7a4dc1aa3f1']),
  // Before the planned-evidence table asked for each row's fulfillment and observable result.
  'singularity/templates/figma-mobile/mobile-spec.md': Object.freeze([
    '18c583c10c597c595cd0be9c11ddf16e92a0b85147efcd4fd3fb1a9bbd96fc44',
    'cdb4cc328b7a60c87fe5e00818f6b04ee8f066ed7dd2840c56bd5c78d413b4e4',
    '9a8203f044109f068ea6282a7352ac6a69eb8cc90139252610f60e106cb6b521'
  ]),
  'singularity/templates/bugfix/fix-spec.md': Object.freeze([
    'c1bbc5602eded66e1387f3fa95a835d7bb49f05a2fd813b193c0cada7c420c87',
    '22558a91a03dbb58569863c24b4d25aee092d1a04138e0285d587d0dab267343',
    'fceed5a1f12fc2be09ec56f0bd1c165efabe8f335df4cf88e6258694bb513e18'
  ]),
  'singularity/templates/feature/implementation-spec.md': Object.freeze([
    'adc2b93c3cf849c4b335237cea68c05fc2fdeb4ef087a8b4236493be574a0a37',
    '39f379c3e28aad96d421aa179a2478457f6903a86ba01aa642bf55791fa5c2fb',
    '033e2f8d2af5e8d762fb1cdbd1bcb5fcb8ba7ec629d158761be832f875cc6014'
  ]),
  'singularity/templates/quick-fix/intake.md': Object.freeze([
    '275f44dee383c77be256be2e070b901d053b1a0a95a2ae92e0c44289c3576983',
    '0b69eba907e67c38617d1ced288986f9ce13a5e9c9ceb2e2be7f942d362d54d9'
  ]),
  'singularity/templates/classic-delivery/intake.md': Object.freeze([
    'd91d55500e7dbc30a388633bce723623157619bca0bbc9bbaf8e64dfd85308a8',
    '556120c9a16a8b6b57df8e001b27a8c769a4ee1c9a783251b1e9f4c47146310e'
  ]),
  'singularity/templates/spec-code-test-loop/specification.md': Object.freeze([
    '4a487088d8275fc54afcb7932c18a4fb04774e85309b26b3ae72618ce9762bc6',
    '15a6f55c50ed316695a172dbeda36594a2c345af7817d50b3244d1dcf119a41e'
  ]),
  'singularity/templates/poc-workflow/ui-exploration.md': Object.freeze([
    '14d107cc9778b9e737327e363e84e60975076a7003016d0798e92496ef1d61f5',
    'f0b14cf81aa72451e3cbf0de71a2dad050200177d66622d0f575541066d6ddf9',
    '43e53c4476249bdd4a9b8af681ca77529d163ec66680d6c4514b0731b9cb1182'
  ]),
  'singularity/templates/benchmark/design.md': Object.freeze([
    '92ba1c0684e20d201a7bfa1c9ae7b61a87001ca0c724ff0a61af2d387b23f9ba',
    'e0bf570cf7f35a123025a41d7b3d3b3977fdc17acc06d8ab85399cb233345fdc',
    '9c06dcf0182701345b6f4f6af8fe4b7740fc080afe23776d4a6d8749196cca26'
  ]),
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
  // First released SKP starter. Exact previous bytes can be upgraded without claiming any
  // repository-customized starter file as framework-owned.
  'singularity/templates/starter-packs/skp-team-notes/README.md': Object.freeze([
    '1880cb24e0dbc1ce84677b183dfd672ed7e85ae86e5735a1e8b9f1cb94817f4c'
  ]),
  'singularity/templates/starter-packs/skp-team-notes/draft-input.json': Object.freeze([
    '14b4b8deafa8a5434edd7046e7203e4520792c5951350f9d7a7f5c4b904d7ced',
    // Before the starter declared the responsibilities its team notes leave undone.
    '71b39ad32ea3d376bf3a9b45a3f3e6cedea81a1cd95948108635be4aca08c6c5'
  ]),
  'singularity/prompts/copilot-planning.md': Object.freeze([
    'd4a47524fb1563faa4a07d63bec271a0c8e3361689fdf75e1d99ea78851af9b6'
  ]),
  // Before the release conformance report disclosed self-approval like every conformance report.
  'singularity/templates/spec-driven/release.md': Object.freeze([
    'bd63555c657657c238da547e8794ca053affbf14c45bd4322a51401bd09fb82f',
    'a78b2eb703b2dfc70ccb33d30d94b24fe39247ca06ba79e6a988054e94a737b7'
  ]),
  // Before the chore intake said which files a chore may change, and before it became the chore's
  // scope-and-plan checkpoint.
  'singularity/templates/chore/intake.md': Object.freeze([
    'd4632690fa411f3926eee1bfd474f5907aae5efdd31313576acdac04e8934441',
    '3eb548ff9d465a536d6108c59f920f9ea62e1c16112c06561ce7a6c0ff856240'
  ]),
  // Before POC Lite declared that it omits scope instead of opting out of planned claims.
  'singularity/templates/poc-lite/plan.md': Object.freeze([
    'cac46909b752b8d14cb4bab3399dd9d57da540e5ba443f171b4c1fb4695882c6'
  ]),
  'singularity/templates/poc-lite/finalize.md': Object.freeze([
    '6e46b121db6e48206916719e66b927c19e3db86bb829c661bff89db74e814940'
  ]),
  // Before the plan could list supporting files that change without a clause, and before it said
  // which files may be supporting.
  'singularity/templates/spec-driven/plan.md': Object.freeze([
    'e8af98405a723a55c572c705e34a5b2fc05a11b3efe632e169ba6becf6c1a04f',
    '251df4ed09c44844edabf7a097d7cdb443f88e9eb66b94716b9ead1ca97498fd',
    '5e70231c6271f9b637f876862847c10ad938bafcab33ad56cdb1d3ad8e5bee5f',
    'bbe153af31a1554ae96d3b3e0314e40d5bc543eb501fd6d18e7dd3f5e619a064',
    'd18e7af418ac8b89af1df8214c015d23828e5c0d9cfad65123c1d37579f295e5',
    'ea181c89f78780be53165f1fbb4436efd4d5ed888e1286765f1bcb938bd06d21'
  ]),
  // Before the specification cited its supporting documents under Sources.
  'singularity/templates/spec-driven/spec.md': Object.freeze([
    '27424a624b1dab57323fd7482ac62708bd42d11ba42e41c102f94e15182fe485'
  ]),
  // Before Story documents needed a name, the import instruction had no --name.
  'singularity/templates/figma-mobile/design-intake.md': Object.freeze([
    'f84db46cdf86cf8c4da4de0062d7150466d5dd291baf6495bd9523affa9a6453'
  ]),
  '.github/agents/architect.agent.md': Object.freeze([
    '6b04a0161f445d0d585933d3891e07522cd652683e580752b5497f14ac86deb0',
    '184ad9effaad2977008687601def19a0677bb72c6a02365ef81b945f54ae6443',
    '0c8630b4f5d3bf2bbdabc4f67f4619caa7e537a566111cef40440c6c7abce016',
    '188198ceb7da73ef10814aaea2426dea127442f199fa16939f84a95415547ee5',
    '28dceea24f5990cb48decf09cff11b29071febdf58a64f9253a09ec19e99d58b',
    '308eaf5824f2a2d431d7bbbf527947087508b408e866584c15d6365db8d1c23c',
    '30dc4a4002ddfabdfdb573ad375c6a704bf7705caf9f7b93fdbc08b27238de83',
    '5ef94064b3e150648c5b8f2220475588575b8f8d8fd1e2c78004950a59798987',
    'c17746841c5afad787e9a33c8a97aa6de15bf44a798d541f1d4c61659485d872',
    'c45b741bd7e5700fa1f4fde5447ee073460cce233c9c60fca4c90a0c2966d271',
    'cb10e2ec957759b702df2935ed7889192da5946814c97f9ca6c9e53b173f3342',
    'd7aa40fde49e3111836cc478b20d9cef03bb403512d48f8fee8b620c6f2af878',
    'da4f136ae11c0cb459500d4008a5629797f168ec4df87ba807da31c12a59c467'
  ]),
  '.github/agents/developer.agent.md': Object.freeze([
    'e58aa358944af2247810f2f272d6571c253d43709da34b0ec7f012083a233606',
    '319bdfa6ac51ff128d8caad683f637f76c04818dc5fc7b05224d5275a76b8c41',
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
    'fee53598c1cf2aa27a365979df06c7bd3f42e3d1b7994b9ecfc2214f31772478',
    '06685d32114d1278a825dfc9313d2c1ca6e4b84de9cf1c112b4b84f82367176d',
    '1cc19f6ab0b71a6c3296e8993c3610570c9ccfe82dc30308e5393e7e36f5ac33',
    '22e5fe1e93ff229de7bcc51b70078d8d4f48b925c0ef802a8ab20d1127883128',
    '25c97dee212791eaeff956b0b32c756272c1e0b9a8bf94819a4bb70c81956a00',
    '314f95afdbc297e47a40fca9bfb8621ebb915d21d40cac18c6978032cd996cd7',
    '41df3ec017a210fd210b351eb5bf99ed278b3f7cdee27073fd93522488393def',
    '74dc5471afefcea6dee62fb5fc710ef019c809e51db3ab7eb203f238536fbf48',
    '830219deadfb61f600397ae9c63402b7954fbc4c21f4a893058a4a138df24903',
    '8304d4312924dc1d261f54d0f898ad3a3b4819091f334fb037e5b92aa91be334',
    'a4424d77b4bef04efbc957706fbaba3f577c6b4371e41cd8f94e4e465b516851',
    'afebe77fff23c5493852c2898a39410d115cae1f346256cbffcda9dd103bcf2b',
    'c0d882e1b6a6a946e4573756aa156e4ca918b578634baa35e6fccb74a595b698'
  ]),
  '.github/agents/poc-analyst.agent.md': Object.freeze([
    '4df9fb95469acfa0a036d44d47ac93a2f2a21a9a70703c98abd43d8460e4442d',
    '94623517e943daa5cbab969fa1a50887319e34e68d826d06e23d17bd171ad2d9',
    '7f4fe9ad6e2bcf0aeab4aa0e2bb5245b38bb1a0434f23b1b604f2869fd9590e8',
    '1d4e071363256e214a58ab810819218cff8f4d288d571487eb6f18d2bca8b1d2',
    '23f6c7215e1a84e3ce249515e504e74b374dbc59177baf00a1f5b611b832310a',
    '582f046a0912e9d7cd2df1a94cb411d1f24b313b28b91795529e7be99f355d8d',
    '604d35e01fb207d693b8067bfa449c8c325b3493a3fb6dc49f5522156009fbe4',
    '7b7690a834615919f4a4417a60783359965a848f8775dfa67acadb818684411d',
    '8edf5a781b1cfab7af89b4ce53f8ac52343d31cd1cb65cfe929da7660dc737ec',
    'a5e8b6d7bd4daaa7eed58f5b4d5aec4985f53e8cc6b79f8b353f31a59c9b2099',
    'b2911fb7034dddec1d44266f83146a0460dc158a3efb6938cdefda2ae0d96086'
  ]),
  '.github/agents/poc-automation.agent.md': Object.freeze([
    'fe311f2172c31133608d1a9d2f2a6afc9229fcec124e05bbd62080ee5b9ec99d',
    'a45c1645749fe9595d5b8bca9c620583f60a9fa34798e492764932d5411c435f',
    '5c113c502f9e02362ff280947747684130b9f0975391b6cbe27462e1faaac0f6',
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
    '839a0e22f66192fe3ff5cb503a211e6baec05760c0463da97a6651071508fcdb',
    'fc8ecbccd7fbfdcfcd318c45a1219bcb3354a09a87a30e941153df43ea390667',
    '5b863a56b6d645a71c858afd8edd29b6f7cbc60b441d4b3b2df513826611ee18',
    '6c471ac9d6bf14f865e73cd1a39a3cef635e3bdc7c4f455d182ae9b0845b7277',
    '73135df4f261fa3e08f8f5676f985da4f3c4b139833413c9d6ffd7db0c6d9a07',
    '8c983c14434e88e8c780874cef06f3d8bc0bd1438447bbbc7a5832050d2dc786',
    '91ee8c5b1df5431f5a72c4d010ffaef470fe088e8918ffda9d0a607780acf65f',
    'b326394f315cb5bbe67aef6f4c3500687b8753dff64fd7a92446558bbd69f498',
    'bdf2798d35072830cb977398148cd1f57c24d73753b418c1e2d2d8bfd96558ba',
    'd0fa8355f9b7bb8924427a8a000c23d65c99062cef507eeffbe6ef3862858c08',
    'e20eb9f019128dce8d1a92842e19b368b012965c1abc5322ae22e57e223abcb8'
  ]),
  '.github/agents/poc-lite-implementer.agent.md': Object.freeze([
    'f97cc8d1cfb1b920e4643337fcc6d5a2b44428249c39a475565015c28ba68a04',
    '8fa2344494618a1200b987aec80600b8d05cde24c3dee57e7ef6934fdd42e064'
  ]),
  '.github/agents/poc-lite-planner.agent.md': Object.freeze([
    'dbe9682cf65511b5d5ea77fecbb2abb1c3ea691c20961ab2faa046924ab16689',
    '13269e0e0dd315c053c81d50d0de27a94a7e1a8621ea1230b24d3a3a53d6c2e1',
    '85b821ac88fb52eb7972f1026f605f04144fb27df5afc2e42fc0c06212562a9b'
  ]),
  '.github/agents/poc-lite-verifier.agent.md': Object.freeze([
    'e6d98806f989c1d6e284223d97725cfc69523ef531c0d2805b32b71d8a42bbc6',
    '32cea87f319945c6ef3963aebf92e55ee15a291f8d7cf5691ca28a38fe68dd42',
    'd2a01fd1beebae0b2399d0a2908d4ac0db5ad8cbc803020f40697914a2b7ee60'
  ]),
  '.github/agents/poc-test-developer.agent.md': Object.freeze([
    '6576545a8047586326e2b48a77d8b92c5325807de7f717a636962eeef0622644',
    'da7785d620f669c41fa07921bcc6ef8bb26bc5fbb7eaca81f470b3fdf1feef8c',
    '20a6a09cc14dac8fd7cb461d412fe708eeaeaf3be55c3787212f4a09bed7e17d',
    '4c82f12e6642c42e60ef6b0e4a19b9c37b70a73c2089b8dfd2c525858d7a4681',
    'c0ac831ab7d1131c361528624e52a06066bbdc2da1ea726e7d089d06c6b37dae',
    'c40ca16bd75bf3d201e4b324500a4623af322e707f25c5de46e64aebc49f4829',
    'ca76f451cc8e91ef327fdcee6fe8c0e0c4338960cc34595ebf8ae2ea9de3fae8',
    'dc91d663a83017267c7366a3ac3e903e7b4fd803af2284b9c7d252bf61c2c8a0'
  ]),
  '.github/agents/poc-validator.agent.md': Object.freeze([
    '0d02fd985d4948ce8a4d3a1145f7334decf60e8d09f4869a9d05fe02715dbd1a',
    'b2bed98021cfb9dd5a9b8ae31d9f0fbea0fee920d0bf968f7d3f9217dd89719d',
    '083dd2ee6f941c5f873f9b42d4ec50faf450cb703fd55951dd55244d1bc1d82e',
    '0d391149188a912560efb6e5d750c06c63c92d8442c474dfbb6a036c7dbfd7e5',
    '28e7ed2f6291a837aaa251a2dd7cf3c2575fca60bfa27bf630f45295a59dc37c',
    '43142777edc499d637bf0ba0371be7e43be32f1fff8964da1b60fd2494db5c34',
    '904954066c83b071fc03c8077733027bb5741b8f870c869e8754a896eeca8714',
    '92a918b0d033899e7f6f0a3c28663b016ba781a005e736ef926023f7be0c625d',
    '970a1539220c22ba61eac4f80a743328437a0913d83fbeec20a6a3ed6f74a10f',
    'a7f8cbf15a2474f2bf4a6f959a95a49917f7a1df3b96b9cf0222ab2a3f8fb4c0',
    'c4b60bf225a36ed4e44d00cfa6c28442eaf4ccc212dfdc0cc7ffdaf33ada0328'
  ]),
  '.github/agents/product-designer.agent.md': Object.freeze([
    '93eec54ac8b0d671804123ee20bdcd67155a02cb274b5168380f7a77db2f1a11',
    '0f5fe7ec6f8e75d85493266f0982db49bac9fb20673867d119ff8e65cc3b54cf',
    '1103db033c0acf04448e1794c40296d50c0794c6860ff5be0b11b258998e230e',
    '2a347736d3ffa58635617b47721c4306d4cb3979af9101a08cb0604b03fe37ec',
    '330f43cec8f05c22cef3fcec99be31daab818b36c2e7dabd25293c95b05acea4',
    '3857dda1a490010c4cba23cbdc0405f6e9fa7e371d904a78b96d1e3130a7604c',
    '644bc2c3ef3a71903eec8a4a4159e158462754991cf490f251a0c956e4209c7a',
    '90a2cf69c295d0062c95a42adb7ff6f40601286641776f077f19922efeeea864',
    'b08909068f12c3caa816fa6fab8855428e40902797a1e78316ff38a367574f16',
    'b360a859d47caf21908fc07bf54d934550e1873158114e2977154e8476135791',
    'b46014bafb6a5fe79642e8e1917f28ef37adc3a8304408534cdcee1e75d47016',
    'd059499cdb40b4d2cddfbfd0588dc2b2ecda51d18d56be3f3a4df8c53c7ec088',
    'd82dd98781ec5ea5895892ec046106aa58dab5575e17cdaf7425fcbe4fddd6e2',
    'd865c816c41be1723bd2d3ef1e769f02821e2a45a75120119f50606a7a3d1fee',
    'e71a3a77592c53010b2de7f107d64f8e401514215e891e37af9660a7ef8fc945'
  ]),
  '.github/agents/product-owner.agent.md': Object.freeze([
    '62c866c5545c95b789bdaa7d279b19074f5d19d690c9a09501dc6464c7506882',
    '84bba38e1fe4dfa812b213255283c202c8a96b81179841bb3cb909f073b99b39',
    '491241469786c77bf5f99384fdb7f9c0da7abf637fb5e8fc531992a6168f0027',
    '54c7240d0b81c04e47c453fd19a29caf358c07d3d36a93b84ff84541e7f9aeb0',
    '5e134b783407788f9c5f42f20bbe8b43fef252a4105f04aa18868a611a2922fd',
    '72bc0c8aada5447e2b8ce1d0450435adb1060bf061e1aae298e6e7ba8cf863ac',
    '86fc702216b2e84cd7ed65ff7ea05b569af345180e9cac6ac14fa5d8bf8526ce',
    'a9c322786305e1eee80229c696ae19ff21e0f4fc2843d4c7f28a80ccd24e96ff',
    'bf34f8e00613be9f03f23b518815cf886fb903c3eba7e5670106bbaca197e4c4',
    'd489c05a63d6e37482f6b8973881898640f72de3739db8e207470a66f2f40b63',
    'dfd54a579bb1abc03c4e2d56f904f4e6d8da39b7564c3dac7bb5d2f20e289a97',
    'ea838bed87ce9d24400e1aaf0423cb829ab5334b6bddd728fa1c074c8ae2e152',
    'f6d6bb18fac60c089b7867453ee4e84759a294a9f42a48ae52f6802f86fb78a0',
    'fcd6757dbc695423e0df1a9bd906e88569c7e000cd84c35f1a1b532bfcd822e2'
  ]),
  '.github/agents/qa.agent.md': Object.freeze([
    'de84f6854724abbda3ba42c8040fdb710147f1574862ea04c8311628ece4e53c',
    '3af12e12be861a865ee17cf3348990798bdc3a89e1263e1abfe7a46c2a10df8a',
    '3c0c9560c422fc616b391277b38d409b004864449b1a9cf4aa06bd5e302233e5',
    '452100331664da07d932209875c45e725ee92f080e541909cd595d3d9bc5cf94',
    '572292f0c00d56aa2a87af1c41f0d3eb2c75d7e09c04b464af5e5663eee32842',
    '5c00c8126703c867854c06c23bfd376e7a191735c438e9545b8a655c06ea71ab',
    '5c8131eb79b2cade08aadb05794e7647d22a717c6e966bd11050ee060a050989',
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
  '.github/agents/demo-intake-analyst.agent.md': 'f2fb5a528c8cc3966901868436afd640489e82fc4c5703787e1d010ef9c2b36e',
  '.github/agents/demo-code-checker.agent.md': '05ac1874b8e0b6a48efde26fd1a77e0c9ce2ecab27de28761a51460fa82deb03',
  '.github/agents/demo-code-repairer.agent.md': 'c79919043b5c93cd43cdd6b297949d948796e8e56c7548d89ebb457472c02bff',
  '.github/agents/demo-story-closer.agent.md': '098d10ddb1af9624cdd93f9fe53909e1fef79d666cd197a2b330c6076f12a5b0',
  'singularity/templates/demo-check-repair-close/intake.md': 'b711a8f37bebf0dda05a99d4bf3efdcbb1bfc424d70d8f69d5c9289c2a6e2b2f',
  'singularity/templates/demo-check-repair-close/check.md': 'cbde6d2812b782f32589db7f95f33c44586ce6e552ce636541326e912c3a1663',
  'singularity/templates/demo-check-repair-close/repair.md': '66af2bad38c83317e4ccd2d96c7713234f64149e7d7015235b98047770f7df30',
  'singularity/templates/demo-check-repair-close/close.md': '9070bc1135edfa168c5c63b43df230dd5997f527e7b7a2931311eb8cca78a2d6',
  'singularity/skill-library/demo-acceptance-intake/SKILL.md': '0ca1d2e0fec9b529070e7ec7128e632e2efc9c6e8089b05443ea928190304896',
  'singularity/skill-library/demo-code-acceptance-check/SKILL.md': '57cd19310b68568853ac9339b4d4d73cece27ff2df57b2fc1110a4e26e7c8870',
  'singularity/skill-library/demo-scoped-code-repair/SKILL.md': '8b5dad40926ef0f95a9d1c9295b2cdcbe9a43f1182636b1d82ff3fa69c2c9871',
  'singularity/skill-library/demo-evidence-bound-close/SKILL.md': 'e18a418b84f1371fa7b86dbf30e9a9015d1ab348bddbb034ff12004f771f7926',
  '.github/agents/demo-web-analyst.agent.md': 'a06f1b514eec22d8e75b2d8b609348f3d43b118f00e456de5b1c3e25ca72e2b1',
  '.github/agents/demo-web-developer.agent.md': '30572f81d47c0c9274872153f93d9313884713c6b25411967468307da703cdfa',
  '.github/agents/demo-web-tester.agent.md': 'effdbb363713e11ebcf06df83c7258dada6ef5b28e7ba012dd3e2f9e74611af3',
  'singularity/skill-library/attachments.yml': '34bb3311f72976388ce8279974354142ccffff182da90ceb7c0cef033bedd027',
  'singularity/skill-library/demo-web-defect-repair/SKILL.md': 'c968f300ac02c798ec54a9b7c83744534b529372fdb60539f164effd251416fb',
  'singularity/skill-library/demo-web-screenshot-check/SKILL.md': '77a7ca8a6afb9a73cbbfda626ce72cec6d07d6b82287b3deaf61159785b0ee5f',
  'singularity/skill-library/demo-web-screenshot-intake/SKILL.md': '225d981bbf356ccbe63033940b4c81172d5985f9453330af275bdd21c4510a63',
  'singularity/templates/demo-web-e2e-testing/check.md': '31bc19257b108572d3043066a8747ade34dc0facb9bc75e013a5b5ded599e2c5',
  'singularity/templates/demo-web-e2e-testing/intake.md': '937e5b69f618050e79cb76e384994ba6349d8bbe59914c7d9117920af35e94f7',
  'singularity/templates/demo-web-e2e-testing/repair.md': '5cf8165f7981c55d1b6d2b6f09e23e0230261eeb98312de213f11b93091f332f',
  '.github/agents/architect.agent.md': '81348d097d9dc7e526319ea242d15178c5a35e7d027b26303be39fd4e8451aa8',
  '.github/agents/developer.agent.md': '5e98b958632baa68321694536f5a6ddc80cef2b11e1bb422796cfbea6d7786c7',
  '.github/agents/document-analyst.agent.md': '03c307bb9396ec71ea8af1a347c45cae82c2e5cb04197588c24ce48ea6559d37',
  '.github/agents/mobile-architect.agent.md': '393e8b3fe7bb07dcfd34f4e7f10be0f124414700414be01b038016087d785958',
  '.github/agents/poc-analyst.agent.md': 'f80f745a90ea2bf7ef2a5aa9ded7438ba7ba10cd74e5364fb818ec29d80bccf4',
  '.github/agents/poc-automation.agent.md': '5608247f349c259850f55ac38072875508e9550ad2ebe706fedfd94e8bfe2e80',
  '.github/agents/poc-explorer.agent.md': '6c6e9515d390d6f4aa715a4921a6ae2748752fa038d2cdf9391b5e712602d45a',
  '.github/agents/poc-lite-implementer.agent.md': '9d907a1f75e54b75a0a581843aa1195c6635e72a351e54e3de0763daeeec0c29',
  '.github/agents/poc-lite-planner.agent.md': '74b564d5ca0063954fedf554d9c2350a9eebf78deef212ed2c6907283f35fdae',
  '.github/agents/poc-lite-verifier.agent.md': '14fe9eb15692eac47922cbc61de3686aec2eedf447544ae6ab6901c70995d33e',
  '.github/agents/poc-test-developer.agent.md': '31c1c375019c83474dec8e0108310d58a52f5cab92c287d59b36f7d6bcc84cd7',
  '.github/agents/poc-validator.agent.md': '33d0cc77990f6320aa03305c0bd8051be7f2b696170132d4161c0aef4ba98894',
  '.github/agents/product-designer.agent.md': '37df7604d2727eeea1cc23d5dee7200fd9a4a4bb16c10f4f9d0e4746a0cd13c5',
  '.github/agents/product-owner.agent.md': '2fd9bdef16bbf508d58125ba519e1ca46f35cb593480cb544c3e91e6dc63ad8a',
  '.github/agents/qa.agent.md': '6d73fddfc57e603970eba377123dfa43e2fbd4b444c006df9f13115496976959',
  '.github/agents/scenario-developer.agent.md': '9fc0f10ebd86aa0f3efb30414b5523fa8afc5732ffaa3402a1387bac671b4c26',
  '.github/agents/scenario-tester.agent.md': '3f9ea64bd093f5fd63c7d7c5837313deff922feae22c5a5b5e76bed6a131d3be',
  'singularity/agent-mappings.yml': '1b39a4f4caa3242749889a291e2259a361c815712bd762abde3db3cbe9f8a688',
  'singularity/impact.yml': 'e91000c4f19ba8f8c08812ebea1d3e825919f5b31dadd1f3e22f1749e3b05313',
  'singularity/modelTiers.yml': '9c829dea6676d1ad6066197a582125ec049a7e42c62300736ec83cb2ba563449',
  'singularity/prompts/copilot-planning.md': '4128acc6930949e4ba1e50e8b8c7c4f7beb23f4361c2e8428475b081712b77db',
  'singularity/prompts/worldmodel-builder.md': 'cd93d41ccc98e4ccc09550c60cc79ad6c5a6004d7f8ea66cec596640ab73ffb4',
  'singularity/templates/benchmark/conformance.md': '6a767297e22cab241d2dfff38c6c5b3fe8298e21c65399825c657f014411ced8',
  'singularity/templates/benchmark/design.md': 'fe3cdb987ebbe39d1e42464cf176f437e45287b589ffc66456c7ba4438bc025d',
  'singularity/templates/benchmark/implementation.md': 'e25ab3d9104c4ddaef541191d544ea032c35f551b9538ad77a38628ca1a58db6',
  'singularity/templates/benchmark/intake.md': '49107281e2e461ede0e000edb51bf9f22aec85ddc84acbd1781680076f795f5c',
  'singularity/templates/benchmark/testing.md': 'a9338f04dbe1be3ad988c331f9b45bab335a4661fb367f2c4f110609049fb9a8',
  'singularity/templates/bugfix/fix-design.md': 'cee7774777fd55a3740ebd9f2cafd100702d52617ae307f80e35764229c7867e',
  'singularity/templates/bugfix/fix-spec.md': 'f62cb2f1e2d275d6826b2f47c356db23a006594b3673d3727af387169851067d',
  'singularity/templates/bugfix/intake.md': 'c0aa89555e400e9c78c782021b1928175607f32ad20773c70fae04b28ced320c',
  'singularity/templates/bugfix/reproduction.md': '083e0361f6ffe9e84905b21558554c8335ab1a036719cb37f104e03f255f3567',
  'singularity/templates/chore/intake.md': '18db52fe527c00d8520463524acd6c2858d93564883b7d024a648ea5b2a7b457',
  'singularity/templates/classic-delivery/code-checking.md': 'cb2a69e08768ab6d38ef3ee3e4326f47f854ec80d9012362d5765f88f58ecda1',
  'singularity/templates/classic-delivery/intake.md': '8e60e4d8551c8a84056ac4e8e30f6d7b95c1639408f65668a55e3ae3ae6b0bb9',
  'singularity/templates/classic-delivery/testing.md': 'd84b65e54ff4210a7fab6cc1af3a2ea45bbba61fbee383a1ef985f31848ff177',
  'singularity/templates/common/conformance.md': '4d0d9502b65b257e2d8b315634b7e6c17c64c531a9efe42849c37be1b3366b1b',
  'singularity/templates/common/implementation.md': 'cf46a21cdcb12035defbb5b6a74c7acd6c6d1e751556964f416f27bb5acb5482',
  'singularity/templates/common/intake.md': 'e16cd8b47f472973823a1a53294c77ac6551285c4df75e916c739611c3bc1d23',
  'singularity/templates/common/verification.md': '31e8dc7c915c96c7bce79e3138af0537875f077350a13af5250e50c4c571728b',
  'singularity/templates/document-test-repair/check.md': '2dcb5121d1577a3a26ca6527f9107336b632600dab21c5fe4c215c23cb84f438',
  'singularity/templates/document-test-repair/intake.md': '93554c5483a2b117dfb48612a432531950b6c0c96c122d83d023344b23e37906',
  'singularity/templates/document-test-repair/repair.md': '51f9d673c5614e202ff9e40aa5e5dd2ba8042fbe87354dd502a0e5497bca2628',
  'singularity/templates/feature/design.md': '8b7455f464a7025efa92942c272a04e3c0a3ab2a4d3eb438703cc14e230bc856',
  'singularity/templates/feature/implementation-spec.md': '775affeb36ab41074d9953109f7459efca860c5d31465c8d5592ad986f311adf',
  'singularity/templates/feature/intake.md': 'eb53814f46f12ea3d93d1629164bd7ff22a3a54feceff7f7dd55670caeb5dbab',
  'singularity/templates/feature/requirements.md': '32016db8ed6fadd6596e7dc702647cff95cdee1a203b38395d7ba5626dd8134e',
  'singularity/templates/figma-mobile/component-mapping.md': 'cdea8a1e3defa73ade72bdaaac162ecd9b8b43817aa319d7e712e2de2eb296a3',
  'singularity/templates/figma-mobile/conformance.md': 'f96e5271156d2dadca7cbf5687599724c4e47e328db6635ccf46b4adacaac147',
  'singularity/templates/figma-mobile/design-intake.md': '5cb9495b64189d9f73d6aae23201197d7634cbf46d03176544badfc7683518ef',
  'singularity/templates/figma-mobile/design-inventory.md': '822ea61a75a25ec5a6b42dd887c842d5126233b36f7f0fc875402f9a43125079',
  'singularity/templates/figma-mobile/implementation.md': '69b5b75886dcc41da4e3063c7ceb6ff805251f98dd40ee41b2bf5de660dc74da',
  'singularity/templates/figma-mobile/mobile-spec.md': '5f25f3417be372a7073ac5ba2676b0e47ea302ff54d1db64270448d635db6d98',
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
  'singularity/templates/initiatives/epic/repository-map.yml': 'f1d971a9d7791427572c8e6bca7fe86b30b3c7762b197e8f7189cd564fa4a64f',
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
  'singularity/templates/poc-lite/finalize.md': '7e9e55b2d7199199b757780b78c83abcc35c0f9a48b6760e68b106282ef9cc57',
  'singularity/templates/poc-lite/plan.md': 'b4748d5dca1e0fdef282f9f679c32ed360d5534a975a4361a2e925dfb1beca8e',
  'singularity/templates/poc-lite/verify.md': 'c31624345a1b3803f1cfe267b670e570e1ad1ae3742e88898d123f962b913a58',
  'singularity/templates/poc-workflow/impact-analysis.md': '16b58133b53c74c225f9e0a10b36301678d3ae5cd1a2686f23d1cbe414ec6c93',
  'singularity/templates/poc-workflow/intake.md': '511fa3a7c281bf8a4c84977668478392b5f73d14273d3149db6392eeba3b805d',
  'singularity/templates/poc-workflow/publication-review.md': 'e5d0e59595e5dd01899883adf781a728bdc6636a07efe4290b57c55b808288d1',
  'singularity/templates/poc-workflow/test-generation.md': '6fa0c17056fe263eb9f47699a84a0759a899b8e67c35a3d53df8961f1ca59b25',
  'singularity/templates/poc-workflow/ui-exploration.md': 'ba1d1918737d8753d51c1d59b368eab9980dbf0b587ddaab88174c68bdd986b1',
  'singularity/templates/poc-workflow/validation.md': 'b1d121afbd49c09538d221cbac60b352a21f7eb7699bc4cba08d35b88ba47fb6',
  'singularity/templates/quick-fix/implement.md': 'dff093133a1be4c93115cfbbb0d994c8ce391fc19279caee30b441ec27a05c0a',
  'singularity/templates/quick-fix/intake.md': 'a1dae2da960302a152df2c87c90673222a9a8a671752ef38d13fe75e94598950',
  'singularity/templates/quick-fix/verify.md': 'a21900d99d044d35de501f0e43888a8a3ebcfe860e702a5d1b3eec61fdd06f27',
  'singularity/templates/spec-code-test-loop/conformance.md': 'b22de4f73720b8bf645faef0e2484031838d511fe4ea06810c6bf9b16c8bae1a',
  'singularity/templates/spec-code-test-loop/specification.md': 'cc407b7192e181456f1ba6e8af2ddfb81ae4329efa2dc829d2aa060cd4e66c1d',
  'singularity/templates/spec-code-test-loop/testing.md': 'eef65b164a45b3df7843d76ef071e9d9932304ec9861c8ed19c646db105f9284',
  'singularity/templates/spec-driven/convergence.md': 'eb257477afca0229ed858875499736c57498015aaee0a527b714356819a9dde2',
  'singularity/templates/spec-driven/plan.md': '66fecb17e2ee3397909ca79f2834e445b27050f2d67d066b434deb589f5ffa04',
  'singularity/templates/spec-driven/release.md': '3d6717eace80085585d04c9c3f5c67f10d7a2e9c4e535a862c8b5aa900d556fe',
  'singularity/templates/spec-driven/spec.md': '55b0d6c4c9aa5ba19739493825f6c993f03d63bed9e1a5e2bb7d5c099b8b91bb',
  'singularity/templates/starter-packs/skp-team-notes/README.md': 'ab3e66d1654df81922a6022c491ac85868cb3b644e0eace77c4f9089c4f599ea',
  'singularity/templates/starter-packs/skp-team-notes/draft-input.json': 'fbc136911e7dfecf14be06091b6d759770fa72c133c39de74710511bfee57410'
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
  // Registered starter-pack files have a fixed repository location and identity. An artifact
  // templatesRoot may sit in the same tree, so other paths there must still be remapped.
  if (relative.startsWith('singularity/templates/starter-packs/')
      && Object.hasOwn(CURRENT_PACKAGED_ASSET_SHA256, relative)) return relative;
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
