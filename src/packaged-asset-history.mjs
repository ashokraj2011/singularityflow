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
 * The entries below were derived from the reviewed `main` history of `templates/agents`, including
 * the current release. Keeping the evidence here makes every initializer and configuration-
 * authority bootstrap use the same compatibility decision instead of growing ad-hoc filename
 * checks. The release check requires every current governed agent to remain registered.
 */
export const KNOWN_PACKAGED_ASSET_SHA256 = Object.freeze({
  // Retired provider maps used the same exact-byte replacement rule before the registry was
  // shared with initialization. Keep them here so every configuration upgrade has one authority.
  'singularity/modelTiers.yml': Object.freeze([
    '9c829dea6676d1ad6066197a582125ec049a7e42c62300736ec83cb2ba563449',
    '9a6b011b1033b205981d7dd1e87a215a3de53f81c2e422a85d9f8d6438d36faf',
    '68f5da2150926169e8316944b9f11a33271d46127abdadcd88a233d2b4e2860a'
  ]),
  '.github/agents/architect.agent.md': Object.freeze([
    '0c8630b4f5d3bf2bbdabc4f67f4619caa7e537a566111cef40440c6c7abce016',
    '188198ceb7da73ef10814aaea2426dea127442f199fa16939f84a95415547ee5',
    '28dceea24f5990cb48decf09cff11b29071febdf58a64f9253a09ec19e99d58b',
    '308eaf5824f2a2d431d7bbbf527947087508b408e866584c15d6365db8d1c23c',
    '30dc4a4002ddfabdfdb573ad375c6a704bf7705caf9f7b93fdbc08b27238de83',
    '5ef94064b3e150648c5b8f2220475588575b8f8d8fd1e2c78004950a59798987',
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
    'c84b47c5353c6db58f0ecc49fe7547254804a4679882d666276344fa9271f149'
  ]),
  '.github/agents/mobile-architect.agent.md': Object.freeze([
    '1cc19f6ab0b71a6c3296e8993c3610570c9ccfe82dc30308e5393e7e36f5ac33',
    '22e5fe1e93ff229de7bcc51b70078d8d4f48b925c0ef802a8ab20d1127883128',
    '25c97dee212791eaeff956b0b32c756272c1e0b9a8bf94819a4bb70c81956a00',
    '41df3ec017a210fd210b351eb5bf99ed278b3f7cdee27073fd93522488393def',
    '74dc5471afefcea6dee62fb5fc710ef019c809e51db3ab7eb203f238536fbf48',
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
    'd73d47b80a35f88d74fb9ea69cb2b2ed5038da3c2692a9626f1141fcfe1fde40'
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
    'e87beaaad02bacff42a0fe75165d46037fc596312fc5085e5ffa8a88b3a6da57',
    'fb292e36fbcf2d741e2493a4677a589c1d16db458c44489e02534b1e56252209'
  ])
});

/** Current release digests, kept separate so a known current file is never offered as repairable. */
export const CURRENT_PACKAGED_ASSET_SHA256 = Object.freeze({
  'singularity/modelTiers.yml': '9c829dea6676d1ad6066197a582125ec049a7e42c62300736ec83cb2ba563449',
  '.github/agents/architect.agent.md': '28dceea24f5990cb48decf09cff11b29071febdf58a64f9253a09ec19e99d58b',
  '.github/agents/developer.agent.md': 'b3ecdcba0c9ebe4cb31eb30232471111822392bf960aa6a67ac92178691dcaf5',
  '.github/agents/mobile-architect.agent.md': 'c0d882e1b6a6a946e4573756aa156e4ca918b578634baa35e6fccb74a595b698',
  '.github/agents/poc-analyst.agent.md': '1d4e071363256e214a58ab810819218cff8f4d288d571487eb6f18d2bca8b1d2',
  '.github/agents/poc-automation.agent.md': '23adcbd69ceef94dba9fc035273cbfa2d878bd72c33c9c3a89ebd1d085a39cd1',
  '.github/agents/poc-explorer.agent.md': '6c471ac9d6bf14f865e73cd1a39a3cef635e3bdc7c4f455d182ae9b0845b7277',
  '.github/agents/poc-lite-implementer.agent.md': '8fa2344494618a1200b987aec80600b8d05cde24c3dee57e7ef6934fdd42e064',
  '.github/agents/poc-lite-planner.agent.md': '85b821ac88fb52eb7972f1026f605f04144fb27df5afc2e42fc0c06212562a9b',
  '.github/agents/poc-lite-verifier.agent.md': 'd2a01fd1beebae0b2399d0a2908d4ac0db5ad8cbc803020f40697914a2b7ee60',
  '.github/agents/poc-test-developer.agent.md': '4c82f12e6642c42e60ef6b0e4a19b9c37b70a73c2089b8dfd2c525858d7a4681',
  '.github/agents/poc-validator.agent.md': '904954066c83b071fc03c8077733027bb5741b8f870c869e8754a896eeca8714',
  '.github/agents/product-designer.agent.md': '90a2cf69c295d0062c95a42adb7ff6f40601286641776f077f19922efeeea864',
  '.github/agents/product-owner.agent.md': '5e134b783407788f9c5f42f20bbe8b43fef252a4105f04aa18868a611a2922fd',
  '.github/agents/qa.agent.md': '5c8131eb79b2cade08aadb05794e7647d22a717c6e966bd11050ee060a050989'
});

// Compatibility alias for callers that only need the path set. Hash classification below still
// distinguishes current from genuinely retired revisions.
export const RETIRED_PACKAGED_ASSET_SHA256 = KNOWN_PACKAGED_ASSET_SHA256;

function normalizedRepositoryPath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\/+/, '');
}

export function packagedAssetSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hasRetiredPackagedAssetHistory(relativePath) {
  const relative = normalizedRepositoryPath(relativePath);
  const current = CURRENT_PACKAGED_ASSET_SHA256[relative];
  return Boolean(KNOWN_PACKAGED_ASSET_SHA256[relative]?.some((digest) => digest !== current));
}

export function isKnownPackagedAssetHash(relativePath, sha256) {
  const revisions = KNOWN_PACKAGED_ASSET_SHA256[normalizedRepositoryPath(relativePath)];
  return Boolean(revisions?.includes(String(sha256 ?? '').toLowerCase()));
}

export function isCurrentPackagedAssetHash(relativePath, sha256) {
  return CURRENT_PACKAGED_ASSET_SHA256[normalizedRepositoryPath(relativePath)]
    === String(sha256 ?? '').toLowerCase();
}

export function isRetiredPackagedAssetHash(relativePath, sha256) {
  return isKnownPackagedAssetHash(relativePath, sha256)
    && !isCurrentPackagedAssetHash(relativePath, sha256);
}

export function isRetiredPackagedAsset(relativePath, bytes) {
  return isRetiredPackagedAssetHash(relativePath, packagedAssetSha256(bytes));
}
