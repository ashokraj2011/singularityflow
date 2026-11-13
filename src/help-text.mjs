import { VERSION } from './version.mjs';

/**
 * The usage synopsis for every command, and the single source of it.
 *
 * `--help` for an individual command reads its lines straight out of here rather than restating
 * them, so a command's synopsis cannot say one thing in the overview and another on its own page.
 * That drift is not hypothetical: this file's `HELP.md` counterpart listed six subcommand families
 * that did not exist.
 */
export const HELP = `Singularity Flow ${VERSION}

Personal Copilot skills plus a deterministic Git-native SDLC utility.

Every command below has a detailed page with options and worked examples:
  singularity-flow <command> --help
  singularity-flow help <command>

Usage:
  singularity-flow appeal preflight [--phase PHASE] [--work-id WORK-ID] [--json]
  singularity-flow appeal prepare --add-location CLAUSE=PATH --reason TEXT [--phase PHASE] [--json]
  singularity-flow appeal prepare --add-supporting PATH=CLASS --supporting-reason TEXT --reason TEXT [--json]
  singularity-flow appeal submit [same selectors as prepare] --confirm PACKET_SHA256 [--json]
  singularity-flow appeal list [--phase PHASE] [--json]
  singularity-flow appeal show APL-ID [--json]
  singularity-flow appeal decide APL-ID --decision account-scope|request-changes --reason TEXT --confirm PACKET_SHA256
  singularity-flow appeal attest APL-ID --confirm DECISION_SHA256 [--json]
  singularity-flow appeal repair-plan|repair-status [--phase PHASE] [--json]
  singularity-flow appeal repair-run --confirm PLAN_SHA256 [--phase PHASE] [--json]
  singularity-flow appeal repair-resume [--phase PHASE] [--json]
  singularity-flow appeal risk-prepare [--phase PHASE] [--gate-mode soft] [--clause EXACT-ID | --finding EXACT-CODE] [--transition publish|submit|approve|consume|terminal] --expires YYYY-MM-DD --reason TEXT [--json]
  singularity-flow appeal risk-prepare --phase PHASE --finding CODE_DELIVERY_EVIDENCE_REQUIRED --evidence-file PATH [--evidence-file PATH]... --expires YYYY-MM-DD --reason TEXT [--json]
  singularity-flow appeal risk-accept [same selectors as risk-prepare] --confirm PACKET_SHA256 [--json]
  singularity-flow appeal risk-attest PQR-ID --confirm DECISION_SHA256 [--json]
  singularity-flow appeal risk-revoke PQR-ID --confirm DECISION_SHA256 --reason TEXT [--json]
  singularity-flow appeal evidence-prepare --phase PHASE --clause EXACT-AC --path STORY/evidence/FILE --method visual|inspection --reason TEXT [--json]
  singularity-flow appeal evidence-accept [same selectors as evidence-prepare] --confirm PACKET_SHA256 [--review-ui] [--json]
  singularity-flow [--no-model] <command> [options]
    --no-model disables every kernel-owned model invocation. Equivalent: SINGULARITY_FLOW_NO_MODEL=1.
  singularity-flow about [--markdown | --json] [--extension-path DIRECTORY]
  singularity-flow --version | --build
    (--version is a bare semver for scripts; --build adds the commit or validated source digest)
  singularity-flow --warm-runtime
    Prepare optional Node bytecode caches for this installed build; no repository commands or models.
  singularity-flow help [TOPIC|COMMAND] [--json]
  sflow specify [WORK-ID] [--json]
  sflow plan [WORK-ID] [--json]
  sflow implement [WORK-ID] [--json]
  sflow converge [WORK-ID] [--json]
  sflow verify [WORK-ID] [--json]
  singularity-flow explain [TOPIC|ALIAS] [--here] [--section HEADING] [--max-bytes N] [--json]
  singularity-flow explain [code [--hunk H-ID | --symbol ID | --clause ID] [--since REVISION]
    [--narrate] [--length brief|standard|long] [--json]]
  singularity-flow explain --subject change|clause|test|line|gap|generation [--id ID]
    [--path PATH --line N [--side before|after]] [--phase PHASE --gen N] [--since REVISION]
    [--work-id ID] [--for reviewer|auditor|developer] [--max-bytes N] [--compare previous|SNAPSHOT-ID]
    [--narrate [--length brief|standard|long] [--commentary]] [--json]
  singularity-flow show <SFREF-HANDLE|SFDOC-HANDLE> [--section HEADING | --json-pointer POINTER | --range RANGE]
    [--max-bytes N] [--json]
  singularity-flow harness report [--json]
  singularity-flow bootstrap <REPOSITORY-URL> --capability ID [--name TEXT] [--kind collection|delivery]
    [--jira-project KEY] [--app-id ID] [--teams A,B] [--into DIRECTORY] [--base DIRECTORY]
    [--state-branch NAME | --no-state-branch] [--no-push] [--json]
  singularity-flow init [--repair] [--work-id WORK-ID] [--base BRANCH] [--fetch]
  singularity-flow init --check [--json]
  singularity-flow init --smart-detect --dry-run [--json]
  singularity-flow init --smart-detect --output REPOSITORY-FILE [--json]
  singularity-flow init --smart-detect --activation proposal-only|review-proposal --output REPOSITORY-FILE [--json]
    [--yes | --accept-proposal REPOSITORY-FILE --confirm SHA256]
  singularity-flow init --recover --proposal SHA256 [--json]
  singularity-flow precheck --quick [--json]
  sflow onboard <LOCAL-PATH> [--remote NAME | --authority-local] [--offline] [--resume OPERATION-ID] [--no-cache] [--json]
  sflow onboard <LOCAL-PATH> --bootstrap --policy unmanaged-local-v1 --authority-local [--json]
  sflow onboard <LOCAL-PATH> --bootstrap --policy POLICY-ID --remote NAME --publish [--json]
  sflow authority refresh <LOCAL-PATH> [--json]
  sflow cache clear --derived --repo <LOCAL-PATH> [--json]
  singularity-flow local start <NAME> --intent <TEXT> --input <ABSOLUTE-PATH>... --classification public|internal|confidential|restricted [--allow-empty-output] [--json]
  singularity-flow local list [--json]
  singularity-flow local status --story <LOC-ID> [--json]
  singularity-flow local freeze --story <LOC-ID> [--output <ABSOLUTE-PATH>]... [--json]
  singularity-flow local verify --story <LOC-ID> --candidate <SHA256> [--json]
  singularity-flow local signer-create --story <LOC-ID> --signer <KEY-ID> [--json]
  singularity-flow local trust-export --story <LOC-ID> --signer <KEY-ID> --out <ABSOLUTE-PUBLIC-KEY-FILE> [--json]
  singularity-flow local review --story <LOC-ID> --candidate <SHA256> --signer <KEY-ID> [--json]
  singularity-flow local publish --story <LOC-ID> --candidate <SHA256> --signer <KEY-ID> [--destination <APPROVED-DIRECTORY>] [--format loc.zip.store.v1] [--json]
  singularity-flow local audit --bundle <ABSOLUTE-ARCHIVE> --trust-key <ABSOLUTE-PUBLIC-KEY-FILE> --signer <KEY-ID> --offline [--json]
  singularity-flow env status [ENVIRONMENT] [--json]
  singularity-flow env audit [--json]
  singularity-flow env bind <ENVIRONMENT> --stdin [--json]
  singularity-flow env unbind <ENVIRONMENT> [--json]
  singularity-flow env files [ENVIRONMENT] [--repository ID | --workspace] [--json]
  singularity-flow env files create <ENVIRONMENT> <PATH> [--from-template] [--repository ID | --workspace] [--json]
  singularity-flow env files link <ENVIRONMENT> <PATH> --to <FILE> [--repository ID | --workspace] [--json]
  singularity-flow env files unlink <ENVIRONMENT> <PATH> [--repository ID | --workspace] [--json]
  singularity-flow env files adopt <ENVIRONMENT> <PATH> [--repository ID | --workspace] [--json]
  singularity-flow env files classify [<PATH> shared --reason <WHY> | <PATH> private] [--repository ID] [--json]
  singularity-flow env files add <ENVIRONMENT> <PATH> --personal [--repository ID | --workspace] [--json]
  singularity-flow env files remove <ENVIRONMENT> <PATH> --personal [--repository ID | --workspace] [--json]
  singularity-flow env files path <ENVIRONMENT> <PATH> [--repository ID | --workspace] [--json]
  singularity-flow env files root <ENVIRONMENT> <DIR> | --clear [--json]
  singularity-flow env files place <ENVIRONMENT> [--capability ID | --workspace] [--json]
  singularity-flow env files suggest [--repository ID] [--json]
  singularity-flow app plan [START-ID] [--capability ID] [--json]
  singularity-flow app start [START-ID] [--capability ID] [--environment ENV] [--expect-command sha256:DIGEST] [--debug]
  singularity-flow app status [--capability ID] [--json]
  singularity-flow app stop [START-ID] [--capability ID] [--json]
  singularity-flow app suggest [--capability ID] [--json]
  singularity-flow app config preview --application-file FILE [--capability ID] [--json]
  singularity-flow tests plan [--capability ID | --work-id ID [--phase PHASE]] [--command ID]... [--json]
  singularity-flow tests run [--capability ID | --work-id ID [--phase PHASE]] [--command ID]... [--environment ENV] [--expect-command sha256:DIGEST]... [--json]
  singularity-flow tests summary [--capability ID | --work-id ID [--phase PHASE]] [--run RUN-ID | --latest] [--json]
  singularity-flow tests base --work-id ID [--phase PHASE] [--command ID]... [--json]
  singularity-flow tests node --work-id ID --node MAJOR [--phase PHASE] [--command ID]... [--json]
  singularity-flow app-review plan|start|status|inspect|feedback|repair|recheck|accept|capture|defer|close [SESSION] [--work-id ID] [--json]
  singularity-flow app-review browser install
  singularity-flow outcome [WORK-ID] [--capability ID] [--json]
  singularity-flow result last [--wait [SECONDS]] [--command WORDS] [--json]
  singularity-flow confirm CODE [--json]
  singularity-flow refresh-branch [--remote origin] [--branch CURRENT] [--json]
  singularity-flow factory-reset [--dry-run] [--confirm "RESET REPOSITORY COMMIT" --expect-scope-sha256 SHA256] [--allow-dirty] [--include-local-documents] [--discard-pending-publications] [--json]
  singularity-flow governance rebuild --dry-run [--remote origin] [--json]
  singularity-flow governance rebuild --confirm-plan grb-DIGEST [--accept-inactive WORKFLOW,...] [--strict] [--json]
  singularity-flow governance restore [--plan grb-DIGEST] [--dry-run | --confirm grb-DIGEST] [--json]
  singularity-flow governance verify --presence [--base REF] [--pull-request N] [--state-records] [--json]
  sflow reset-all [--yes] [--discard-pending-publications] [--json]
  singularity-flow local-reset [--dry-run | --confirm "RESET LOCAL"] [--discard-pending-publications] [--json]
  singularity-flow local-reset --forget-only [--dry-run | --confirm "FORGET LOCAL"] [--json]
  sf-local-reset [--dry-run | --confirm "RESET LOCAL"] [--discard-pending-publications] [--json]
  sf-local-reset --forget-only [--dry-run | --confirm "FORGET LOCAL"] [--json]
  singularity-flow fresh-install [--checkout DIRECTORY] [--yes] [--registry URL] [--cli-only] [--no-copilot-telemetry] [--discard-pending-publications]
  singularity-flow reinstall --checkout DIRECTORY [--dry-run | --confirm "REINSTALL SINGULARITY FLOW FINGERPRINT"]
    [--registry URL] [--cli-only] [--no-copilot-telemetry] [--skip-tests] [--json]
  sf-reinstall --checkout DIRECTORY [--dry-run | --confirm "REINSTALL SINGULARITY FLOW FINGERPRINT"]
    [--registry URL] [--cli-only] [--no-copilot-telemetry] [--skip-tests] [--json]
  singularity-flow product status [--json]
  singularity-flow product align [--dry-run] [--json]
  singularity-flow product reviews [--json]
  singularity-flow stack status [--epic EPIC-ID] [--json]
  singularity-flow stack sync --epic EPIC-ID [--json]
  singularity-flow regression analyze [--base main] [--good REF] [--bad HEAD] [--path PATH]... [--max 20] [--json]
  singularity-flow start <WORK-ID> [--jira | --github URL|owner/repo#number | --story-file FILE] [--title TEXT] [--description TEXT]
    [--acceptance-criteria TEXT] [--document FILE --document-name TEXT [--document-phases PHASE,...|all] [--document-store git|local]]...
    [--document-url URL --document-url-name TEXT [--document-url-phases PHASE,...|all]]... --from-branch BRANCH [--fetch] [--allow-dirty]
    Document phases and storage are given once for every document, or once per document in the same order.
    [--reference-repository ID=URL --reference-branch ID=BRANCH]...
    [--work-type ID] [--target-url AUTHORIZED-URL] [--agent ID] [--ref CANONICAL-BRANCH] [--capability ID] [--selection-receipt TOKEN]
    [--spec SPEC-ID[@N][=REQ-001,...] [--allow-partial-dependency --reason TEXT]]... [--address FINDING-ID,...]
    [--isolated-worktree] [--intake-receipt ID] [--baseline-failures repair-in-story|resolve-outside]
    [--readiness-baseline reuse|run|defer] [--test-execution-mode changed-and-affected|all-configured|new-and-changed]
    [--gate-mode hard|soft]
    [--test-baseline-disposition fix --test-execution-mode changed-and-affected|all-configured --test-baseline-scope reuse --test-policy-confirm PLAN-DIGEST]
  singularity-flow choices begin start <WORK-ID> [--json]
  singularity-flow choices begin approve <WORK-ID> [--fetch] [--json] [--review-packet]
  singularity-flow choices answer <TOKEN> <CHOICE> <ID> [--json]
  singularity-flow choices status <TOKEN> [--json]
  singularity-flow resume <WORK-ID|BRANCH> [--fetch] [--allow-dirty]
  singularity-flow return <WORK-ID> [--apply --confirm WORK-ID] [--offline] [--json]
  singularity-flow cancel <WORK-ID> --release [--apply --confirm WORK-ID] [--json]
  singularity-flow agent [WORK-ID] [--agent ID]
  singularity-flow session current|status|candidates|doctor [--json]
  singularity-flow session current --for-agent --json
  singularity-flow session candidates [--workspace WORKSPACE --repository ID] [--table | --json] [--diagnostics] [--refresh]
  singularity-flow session workspace <WORKSPACE> [--repository ID] [--story ID] [--json]
  singularity-flow session attach <WORK-ID> [--workspace WORKSPACE --repository ID] [--json]
  singularity-flow session open [<WORK-ID>] [--workspace WORKSPACE --repository ID] [--json] [--refresh]  Without an ID: the Story table. With one: open or attach it, check the binding, brief context and next steps
  singularity-flow session open-local <WORK-ID> [--workspace WORKSPACE --repository ID] [--json]
  singularity-flow session repair-selection <WORK-ID> --confirm <WORK-ID> [--json]
  singularity-flow session context [--work-id WORK-ID] [--flight-plan CFP-ID]
    [--slice brief|impact|world-model|ast|evidence|history|observation]
    [--observation-kind KIND --observation-file REPOSITORY-PATH [--observation-exit-code N]]
    [--max-output-bytes 32768] [--json]
  singularity-flow session context --expand-handle SEALED-HANDLE [--json]
  singularity-flow receipt show [WORK-ID] [--packet SHA256] [--json|--markdown]
  singularity-flow goal create "<OUTCOME>" --success "<OBSERVABLE SUCCESS>" [--success TEXT]...
    [--work-id WORK-ID] [--kind story|initiative] [--repository ID] [--json]
  singularity-flow goal list [--status active|achieved|abandoned|all] [--all] [--json]
  singularity-flow goal show [GOAL-ID] [--json]
  singularity-flow goal status [GOAL-ID] [--json]
  singularity-flow goal next [GOAL-ID] [--json]
  singularity-flow goal use <GOAL-ID> [--json]
  singularity-flow goal link [GOAL-ID] <WORK-ID> [--kind story|initiative] [--repository ID] [--json]
  singularity-flow goal unlink [GOAL-ID] <WORK-ID> [--kind story|initiative] [--repository ID] [--json]
  singularity-flow goal complete [GOAL-ID] --confirm GOAL-ID [--note TEXT] [--json]
  singularity-flow goal abandon [GOAL-ID] --reason TEXT --confirm GOAL-ID [--json]
  singularity-flow goal propose "<OUTCOME>" --success "<CRITERION>" [--json]
  singularity-flow goal govern <PERSONAL-GOAL-ID> [--id GEX-ID] [--json]
  singularity-flow goal list --mode governed [--json]
  singularity-flow goal inspect <GEX-ID> [--json]
  singularity-flow goal impact <GEX-ID> [--json]
  singularity-flow goal plan <GEX-ID> [--json]
  singularity-flow goal plan approve <GEX-ID> --generation N --confirm PLAN-HASH [--json]
  singularity-flow goal run-next <GEX-ID> [--json]
  singularity-flow goal run-until-blocked <GEX-ID> [--json]
  singularity-flow goal verify <GEX-ID> [--criterion CLAUSE-ID] [--json]
  singularity-flow goal change <GEX-ID> [--json]
  singularity-flow goal pause <GEX-ID> --reason TEXT [--json]
  singularity-flow goal resume <GEX-ID> [--json]
  singularity-flow goal sync <GEX-ID> [--json]
  singularity-flow goal abandon <GEX-ID> --reason TEXT --confirm GEX-ID [--json]
  singularity-flow goal trace <GEX-ID> [--criterion CLAUSE-ID] [--json]
  singularity-flow auto plan "<REQUIREMENT>" [--capability ID] [--work-type ID] [--work-id ID]
    [--from-branch BRANCH] [--profile story|auto-select|sgos]
    [--pace step|continuous|phase|interval:DURATION] [--interval DURATION] [--until SELECTOR] [--json]
  singularity-flow auto plan --story <STORY-ID> [--json]  (read-only next-segment proposal)
  singularity-flow auto "<REQUIREMENT>" [the same planning options; creates a Plan only]
  singularity-flow auto --goal <GOL-ID|GEX-ID> [the same planning options; creates a Goal-bound Plan only]
  singularity-flow auto show-plan <PLAN-ID> [--json]
  singularity-flow auto start <PLAN-ID> --confirm <PACKET-SHA256> [--json]
  singularity-flow auto start --plan <PLAN-ID> --confirm <PACKET-SHA256> [--json]
  singularity-flow auto list [--json]
  singularity-flow auto continue <STORY-ID> [--json]
  singularity-flow auto adopt --from-adhoc <AHS-ID> [--capability ID] [--work-type ID]
    [--work-id ID] [--from-branch BRANCH] [--pace MODE] [--until SELECTOR] [--json]
  singularity-flow auto status|report <FLIGHT-ID> [--json]
  singularity-flow auto compare <FLIGHT-ID> --study <IMPACT-STUDY-ID> [--json]
  singularity-flow auto pause|stop|halt|takeover <FLIGHT-ID> [--json]
  singularity-flow auto resume <FLIGHT-ID> --confirm <CHECKPOINT-SHA256> [--json]
  singularity-flow auto discard <FLIGHT-ID> --confirm <FLIGHT-ID> [--json]
  singularity-flow adhoc start ["NOTE"] [--from REVISION] [--include-existing] [--mode in-place] [--json]
  singularity-flow adhoc status [SESSION-ID|all] [--json]
  singularity-flow adhoc diff|effects|evidence [SESSION-ID] [--json]
  singularity-flow adhoc pause|resume [SESSION-ID] [--json]
  singularity-flow land [SESSION-ID] [--json]
  singularity-flow adhoc intent confirm [SESSION-ID] --objective TEXT --success TEXT [--success TEXT]... --confirm CHANGE-SET-SHA256
  singularity-flow adhoc claim <RESOURCE> --clause CLAUSE-ID [--session SESSION-ID]
  singularity-flow adhoc claim --all --clause CLAUSE-ID [--session SESSION-ID]
  singularity-flow adhoc landing preview [SESSION-ID] [--test-command ID] [--json]
  singularity-flow adhoc publish <SESSION-ID> --confirm PACKET-SHA256 [--json]
  singularity-flow adhoc sync <SESSION-ID> [--json]
  singularity-flow adhoc promote [SESSION-ID] [--json]
  singularity-flow adhoc close [SESSION-ID] --local-only [--json]
  singularity-flow inbox [--offline] [--json]
  singularity-flow status [WORK-ID] [--git-shadow] [--submission-readiness] [--json]
  singularity-flow status <WORK-ID> --submission-readiness --json --submit-if-ready
  singularity-flow progress [WORK-ID] [--json|--markdown]
  singularity-flow report [WORK-ID] [--format md|html|json] [--out FILE] [--timings]
  singularity-flow report [WORK-ID] --recap [--length brief|standard|full] [--locale TAG] [--timezone ZONE]
  singularity-flow impact preview "CHANGE INTENT" [--file PATH|--symbol NAME|--issue ID|--build ID] [--no-ast] [--json]
  singularity-flow impact explain <CFP-ID> [FINDING-ID] [--json]
  singularity-flow impact refresh <CFP-ID> [--no-ast] [--json]
  singularity-flow impact disposition <CFP-ID> <FINDING-ID> --disposition included|excluded|investigate|create-follow-up|challenge-requirement|ask-owner [--reason TEXT]
  singularity-flow impact start <CFP-ID> --work-id ID [--work-type TYPE] --confirm <CFP-ID> [--worktree PATH] [--independent] [--json]
  singularity-flow impact expansion <WORK-ID> <PATH> --disposition explained|accepted-expansion|deviation|follow-up|requirement-challenge --reason TEXT --confirm <PATH>
  singularity-flow impact study list|show [STUDY] [--json]
  singularity-flow impact study prompt-hash <singularity/prompts/PROMPT.md> [--json]
  singularity-flow impact enroll [WORK-ID] --complexity BAND --risk BAND --confirm
  singularity-flow impact enroll [WORK-ID] --opt-out --reason TEXT --confirm
  singularity-flow impact status [WORK-ID] [--json]
  singularity-flow impact exposure attest [WORK-ID] --phase PHASE --level LEVEL --assurance ASSURANCE [--reason TEXT]
  singularity-flow impact evidence import <FILE> [WORK-ID]
  singularity-flow impact evidence collect <PROVIDER> <FILE> [WORK-ID] --commit SHA --run-id ID [--provider-version VERSION]
  singularity-flow impact finalize [WORK-ID] [--json]
  singularity-flow impact verify [WORK-ID] [--json]
  singularity-flow impact export --out FILE [--study STUDY] [--json]
  singularity-flow impact compare <STUDY> [--filter DIMENSION=VALUE]... [--json]
  singularity-flow impact doctor [WORK-ID] [--json]
  singularity-flow telemetry status [--json]
  singularity-flow telemetry probe [--json]
  singularity-flow telemetry enable [--confirm "ENABLE LOCAL USAGE"] [--json]
  singularity-flow telemetry disable [--json]
  singularity-flow telemetry reconcile [PHASE] [--json]
  singularity-flow telemetry chat [status|sync] [--json]
  singularity-flow telemetry sessions [status|sync] [--json]
  singularity-flow context xray [WORK-ID] [--work-id WORK-ID] [--phase PHASE] [--packet CTX-ID] [--json]
  singularity-flow context compile [WORK-ID] [--work-id WORK-ID] [--flight-plan CFP-ID] [--profile PROFILE] [--slice SLICE]... [--max-output-bytes N] [--json]
  singularity-flow context expand <SEALED-HANDLE> [--json]
  singularity-flow context doctor [--json]
  singularity-flow tokens status [WORK-ID] [--work-id WORK-ID] [--phase PHASE] [--json]
  singularity-flow tokens report [WORK-ID] [--work-id WORK-ID] [--phase PHASE] [--packet CTX-ID] [--json]
  singularity-flow tokens report --today [--json]
  singularity-flow tokens compare --study STUDY-ID [--filter DIMENSION=VALUE]... [--json]
  singularity-flow copilot [--mode interactive|plan] [--repository ID] [--story ID]
    [--host cli|vscode-terminal|intellij-terminal] [--dry-run]
  singularity-flow prompt-log on|off|status
  singularity-flow prompt-log list [--agent ID] [--phase ID] [--work-id ID] [--limit N] [--include-prompt] [--json]
  singularity-flow prompt-log view [RECORD-ID|latest] [--raw] [--json]
  singularity-flow prompt-log retention --retention-days 1..365
  singularity-flow prompt-log repair --confirm "REPAIR PROMPT AUDIT"
  singularity-flow prompt-log clear --confirm "DELETE PROMPT AUDIT"
  singularity-flow help-metrics status [--json]
  singularity-flow help-metrics on [--json]
  singularity-flow help-metrics off [--json]
  singularity-flow help-metrics clear [--json]
  singularity-flow ledger init [--json]
  singularity-flow ledger doctor [--json]
  singularity-flow ledger status [--json]
  singularity-flow ledger log [--limit N] [--json]
  singularity-flow ledger show <HASH|EVENT-ID> [--json]
  singularity-flow ledger verify [--offline] [--json]
  singularity-flow ledger repair [--source-remote REMOTE] [--dry-run]
    [--restore-remote --confirm "RESTORE LEDGER PINS <PLAN-SHA256>"] [--json]
  singularity-flow ledger reconcile [WORK-ID] [--json]
  singularity-flow ledger archive [--out FILE] [--sign] [--json]
  singularity-flow ledger deployment-check [--offline] [--record] [--authority GROUP]
    [--confirm-protected] [--confirm-push-policy] [--confirm-pin-retention] [--json]
  singularity-flow capabilities list [--json]
  singularity-flow capabilities show <ID> [--json]
  singularity-flow capabilities doctor [ID] [--offline] [--json]
  singularity-flow capabilities lease grant <ID> --expires ISO --reason TEXT --policy FILE_OR_JSON --confirm <ID>
  singularity-flow capabilities lease revoke <ID> <LEASE-ID> --reason TEXT --confirm <ID>
  singularity-flow quickstart [--keep] [--json]
  singularity-flow guide [WORK-ID] [--json]
  singularity-flow guide --first-run [--keep] [--json]
  singularity-flow nextsteps [WORK-ID] [--json]
  singularity-flow action plan [STORY-OR-INITIATIVE] [--ttl-ms N] [--json]
    [--operation publish|lifecycle] [--decision NAME=VALUE]...
  singularity-flow action authorize <PLAN-ID> --action ACTION-ID --confirm ACTION-ID [--channel terminal|vscode] [--json]
  singularity-flow action execute <PLAN-ID> [--action ACTION-ID] [--authorization TOKEN] [--json]
  singularity-flow next [--task TEXT] [--fetch] [--yes] [--skip-checks]
  singularity-flow run [--task TEXT] [--yes]
  singularity-flow run --repair-on-fault [--max-attempts N] [--allow-path PATH]... -- <COMMAND> [ARGUMENTS...]
  singularity-flow fault report [--from ENVELOPE.json | --source SOURCE --environment ENV --type TYPE]
    [--build ID] [--commit SHA] [--story WORK-ID] [--command TEXT | --command-argv JSON]
    [--exit-code N]
    [--message TEXT] [--log FILE]... [--idempotency-key KEY] [--json]
  singularity-flow fault list [--status recorded|repair-active|resolved] [--limit N] [--json]
  singularity-flow fault show <FAULT-ID> [--json]
  singularity-flow fix <FAULT-ID> [--diagnose-only | --plan-only] [--auto] [--max-attempts N]
    [--allow-path PATH]... [--verify COMMAND | --verify-argv JSON]... [--json]
  singularity-flow repair list [--status STATUS] [--json]
  singularity-flow repair status <REPAIR-ID> [--json]
  singularity-flow repair authorize <REPAIR-ID> --confirm PLAN-SHA256 [--open] [--json]
  singularity-flow repair attempt <REPAIR-ID> --patch PATCH-FILE [--json]
  singularity-flow repair cancel <REPAIR-ID> --reason TEXT [--json]
  singularity-flow doctor [WORK-ID] [--offline] [--performance] [--json]
  singularity-flow check [--for-agent] [--json]
    Refresh local repository and accepted workflow checks now, ignoring the routine-check cache.
    No tests, remote fetch, preparation, publication or approval. Copilot: /sf-check; VS Code: @sflow /check.
    Routine entry checks default to cached / 30 minutes. VS Code settings:
    singularityFlow.repositoryCheckMode (always|cached|manual), singularityFlow.repositoryCheckIntervalMinutes.
    Shell overrides: SINGULARITY_FLOW_REPOSITORY_CHECK_MODE and SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES.
  singularity-flow doctor --git-speed [--apply] [--enable fsmonitor] [--enable untracked-cache] [--json]
  singularity-flow doctor --fix telemetry [--confirm "ENABLE LOCAL USAGE"] [--json]
  singularity-flow home [--workspace ID] [--lens developer|qa|architect|product-owner|admin]
    [--request TEXT] [--json]
                                                           conversational Home (alias: cockpit)
  singularity-flow journal today [--workspace ID] [--date YYYY-MM-DD] [--json]
  singularity-flow journal refresh [--workspace ID] [--json]
  singularity-flow journal settings [--mode off|sflow-only|workspace-facts|enhanced]
    [--retention-days N] [--time-zone ZONE] [--json]
  singularity-flow journal pause [--json]
  singularity-flow journal resume [--json]
  singularity-flow journal delete (--date YYYY-MM-DD --confirm YYYY-MM-DD
    | --all --confirm "DELETE LOCAL JOURNAL") [--json]
  singularity-flow journal export --date YYYY-MM-DD --format markdown|json --output PATH [--dry-run]
  singularity-flow journal doctor [--json]
  singularity-flow recommend [--workspace ID] [--json]     one grounded next-step recommendation
  singularity-flow approvals [WORK-ID] [--json]            phase documents, authority and decisions (alias: approval-chain)
  singularity-flow logs [--tail N] [--level LEVEL] [--event PATTERN] [--since WHEN] [--json]
  singularity-flow logs path|level
  singularity-flow logs performance [--action UUID] [--limit N] [--timeline] [--json]
      local classified traces; opt in with SINGULARITY_FLOW_PERF_TRACE=1
  singularity-flow logs workspace [--source all|activity|prompt|telemetry|workspace]
      [--repository ID] [--work-id ID] [--phase ID] [--agent ID]
      [--level error|warn|info|debug] [--since ISO-TIMESTAMP] [--limit N] [--json]
  singularity-flow hook <turn-intent|turn-end|agent-start|session-start|agent-guard>
  singularity-flow secrets scan [--staged] [--json]
  singularity-flow secrets protect [--force]
  singularity-flow review [PHASE] [--phase PHASE] [--format md|html|json] [--out FILE]
  singularity-flow review-source context <specification|planning> [--json]
      read pinned inputs, canonical reportSchema, and reportTemplate (planning mappings are prefilled, not assessed)
  singularity-flow review-source check <specification|planning> --report-file GIT-PRIVATE-FILE [--json]
      read-only format, citation and binding preflight; no commit, push, human decision or approval
  singularity-flow review-source submit <specification|planning> --report-file GIT-PRIVATE-FILE [--json]
      reject malformed packets before mutation; retain valid independent review evidence, including real gaps
  singularity-flow review-source decision-context <phase> --work-id WORK-ID --finding ID --reason TEXT [--json]
      inspect the exact human disposition packet and its confirmation hash; no state change
  singularity-flow review-source decide <phase> --work-id WORK-ID --finding ID --reason TEXT --confirm SHA256 [--json]
      record an authorized human decision on an exclusion or not-applicable test exception
  singularity-flow review-source status <specification|planning> [--json]
      re-evaluate the latest report, source hashes, artifact hashes, and human decisions
  singularity-flow workflow list [--json] [--for-start]    every workflow, Story and Initiative
  singularity-flow workflow author [list|read WFD-ID|show WFD-ID|history WFD-ID|op-status OP-ID] [--json]
  singularity-flow workflow author create [WFD-ID] --operation-id ID --expected-head empty|OID [--name TEXT] [--input FILE|@approved-starter/ID] [--json]
  singularity-flow workflow author save WFD-ID --operation-id ID --expected-head OID --epoch 1 [--name TEXT] [--input FILE|@approved-starter/ID] [--json]
  singularity-flow workflow author delete WFD-ID [--operation-id ID] [--json]
  singularity-flow workflow author preview WFD-ID [--revision N] [--json]
  singularity-flow workflow author catalog [--kind KIND] [--limit N] [--cursor N] [--json]
  singularity-flow workflow author where-used SKILL-ID [--package-sha256 SHA256] [--limit N] [--cursor N] [--expected-source SHA256] [--json]
  singularity-flow workflow author where-used SKILL-ID --story STORY-ID [--ref HEAD|refs/heads/BRANCH|refs/remotes/REMOTE/BRANCH] [--commit COMMIT] [--snapshot-revision N] [--package-sha256 SHA256] [--limit N] [--cursor N] [--expected-source SHA256] [--json]
                                                        read-only exact approved configuration or selected accepted Story revision; not a complete Story inventory
  singularity-flow workflow author submit WFD-ID --revision N [--json]
                                                        shared inert Git drafts; not configuration approval or activation
                                                        --expected-authority REMOTE asserts the observed destination; never overrides it
  singularity-flow skill inspect <LOCAL-DIRECTORY> [--skill-id ID] [--json]    read-only candidate package inspection
  singularity-flow skill approved <ID> [--expected-package-sha256 SHA256] [--json]
                                                        inspect a skill in verified approved configuration
  singularity-flow skill doctor <ID> --story WORK-ID --phase PHASE-ID [--source LOCAL-DIRECTORY] [--json]
                                                        inspect exact retained Story bytes; never adopts a newer source
  singularity-flow skill list [--json]                  the skill master: named skills any agent can attach, and who uses them
  singularity-flow skill show <ID> [--json]
  singularity-flow instruction list [--json]            reusable instruction catalog; no implicit global application
  singularity-flow instruction show <ID> [--json]
  singularity-flow instruction create <ID> --description TEXT (--from FILE | --instructions TEXT) [--label TEXT] [--operation-id ID] [--dry-run] [--propose] [--json]
  singularity-flow instruction edit <ID> [--label TEXT] [--description TEXT] [--from FILE | --instructions TEXT] [--operation-id ID] [--dry-run] [--propose] [--json]
  singularity-flow instruction remove <ID> [--operation-id ID] [--dry-run] [--propose] [--json]
                                                        detach references first; changes use configuration approval
  singularity-flow skill create <ID> --description TEXT (--from FILE | --instructions TEXT) [--label TEXT] [--operation-id ID] [--dry-run] [--propose] [--json]
  singularity-flow skill edit <ID> [--label TEXT] [--description TEXT] [--from FILE | --instructions TEXT] [--operation-id ID] [--dry-run] [--propose] [--json]
                                                        create/edit: --instruction-refs ID,ID (empty on edit clears refs)
  singularity-flow skill attach <ID> --agent AGENT [--phases A,B] [--use TEXT] [--operation-id ID] [--dry-run] [--propose] [--json]
  singularity-flow skill attach <ID> --workflow WORKFLOW [--phases A,B] [--use TEXT] [--operation-id ID] [--dry-run] [--propose] [--json]
                                                        the agent reads and applies the skill in those steps (all steps by default)
  singularity-flow skill detach <ID> --agent AGENT [--operation-id ID] [--dry-run] [--propose] [--json]
  singularity-flow skill detach <ID> --workflow WORKFLOW [--operation-id ID] [--dry-run] [--propose] [--json]
  singularity-flow skill remove <ID> [--operation-id ID] [--dry-run] [--propose] [--json]    also detaches it from every agent
                                                        --operation-id names a draft save: the same ID again returns that draft;
                                                        without it, repeating the latest save of a subject is the same save
  singularity-flow workflow skills-recipe <ID> --label TEXT --phases a,b,c [--planned-claims required --clause-phases CRITERIA --claim-owners CODE=PLAN] [--json]
  singularity-flow workflow studio [show] [--json]
  singularity-flow workflow markup example [--json]
  singularity-flow workflow intent catalog [--source approved|installed] [--kind KIND] [--query TEXT] [--tag TAG] [--limit 1..64] [--cursor N] [--expected-source SHA256] [--json]
  singularity-flow workflow intent show KIND ID --expected-source SHA256 [--source approved|installed] [--json]
  singularity-flow workflow intent example [--source approved|installed] [--json]
  singularity-flow workflow intent attachments [--file FILE]... [--folder DIRECTORY]... [--expected-source SHA256] [--id ID] [--json]
  singularity-flow workflow markup compile <FILE|-> [--out BUNDLE.json] [--json]
  singularity-flow workflow markup compile <FILE|-> [--design-review|--inspect-phase PHASE] --json
  singularity-flow workflow studio apply --change-set FILE|- [--dry-run] [--propose] [--json]
                                                        read-only BYO/mixed recipe preview; no activation or host launch
  singularity-flow workflow create <ID> --phases a,b,c [--label TEXT] [--governs story|initiative] [--propose]
    [--loop from:to:maxAttempts[:resetOnPhase]]...  bounded reviewer-directed Story rework
    [--planned-claims required --clause-phases a,b --claim-owners code=plan]
  singularity-flow workflow edit <ID> [--phases a,b,c] [--planned-claims auto|required]
    [--loop from:to:maxAttempts[:resetOnPhase]]... | [--clear-loops]
    (--loop replaces the Story workflow's loop set; --clear-loops removes it)
  singularity-flow workflow proposals [--all] [--json]     pending configuration review branches
  singularity-flow workflow proposal <BRANCH> [--json]     exact commits, files and diff to review
  singularity-flow workflow activate <BRANCH> --confirm <COMMIT> [--acknowledge-unprotected]
    (the line workflow proposal prints for a waiting proposal; --acknowledge-unprotected accepts that SFlow
     updates sflow/config itself: a protected branch refuses, nothing changes, and it is merged through review.
     VS Code: Workflow Studio → Changes → Review and activate)
  singularity-flow workflow edit <ID> [--phases a,b,c] [--label TEXT] [--description TEXT] [--propose]
  singularity-flow workflow export --workflow ID [--workflow ID...] --out FILE [--json]
                                                        export selected workflows and their complete dependency closure
  singularity-flow workflow import <FILE> [--dry-run] [--confirm PLAN-SHA256] [--propose] [--json]
    [--resolve KIND:ID=keep|replace|rename[:NAME]]... [--resolve-all suggested|keep|replace|rename]
                                                        preview, then import an exact workflow bundle through configuration review;
                                                        each same-name conflict needs a choice
  singularity-flow workflow import-team inspect <DIRECTORY> [--entry AGENT]... [--root DIRECTORY]...
    [--max-files N] [--max-total-bytes N] [--json]
                                                        capture a team's agents, skills and instructions (screened, never executed)
                                                        and open a conversion session once the entry agent is known
  singularity-flow workflow import-team compile --session ID [--dry-run] [--answer ID=CHOICE]...
    [--destination REPOSITORY] [--out FILE] [--allow-not-ready] [--json]
                                                        check the candidate, simulate its routes, preview its import and write
                                                        one workflow bundle only when it is ready
  singularity-flow workflow import-team status [--session ID] [--json]
                                                        list conversion sessions (machine-local, kept seven days)
  singularity-flow workflow import-team export --session ID --out FILE [--json]
  singularity-flow workflow import-team import --file FILE --folder DIRECTORY... [--json]
                                                        move a session to another computer; compile still checks the folder holds what was read
  singularity-flow workflow copy <[story|initiative:]SOURCE> <TARGET> --label TEXT
    [--dry-run] [--confirm PLAN-SHA256] [--propose] [--json]
                                                        linked copy: preserve the complete workflow record and reuse dependencies
  singularity-flow workflow duplicate <[story|initiative:]SOURCE> <TARGET> --label TEXT
    [--dry-run] [--confirm PLAN-SHA256] [--propose] [--json]
    [--resolve KIND:ID=rename:NAME]...                    independent copy with renamed editable dependencies;
                                                        compiled skill / canonical Epic steps remain shared and read-only
    Seeded workflows and their shared dependencies are read-only. Duplicate before customizing.
  singularity-flow workflow archive <[story|initiative:]ID> [--reason TEXT] [--new-default ID] [--propose] [--json]
                                                        keep the workflow and everything it uses; new Stories cannot choose it
  singularity-flow workflow restore <[story|initiative:]ID> [--propose] [--json]
                                                        offer an archived workflow to new Stories again
  singularity-flow workflow delete <[story|initiative:]ID> --dry-run [--new-default ID] [--json]
  singularity-flow workflow delete <[story|initiative:]ID> --confirm PLAN-SHA256 [--new-default ID] [--propose] [--json]
                                                        remove the workflow and each dependency no other workflow uses;
                                                        a backup bundle is saved first. Seeded workflows can be archived, not deleted.
  singularity-flow workflow phase add <ID> [--label TEXT] [--lanes a,b]
    [--agents a,b] [--task code|analyze|none] [--authorities group-a,group-b] [--minimum N]
    [--governs story|initiative] [--propose]    defaults to Story; a new Story phase needs a default agent
    (a phase runs nowhere until a workflow lists it)
  singularity-flow workflow phase edit <ID> [--label TEXT] [--agents a,b]
    [--task code|analyze|none] [--authorities group-a,group-b] [--minimum N] [--propose]
    (--governs is inferred from where the phases already live, and rarely needed)
  singularity-flow workflow phase output add <PHASE> <OUTPUT> --label TEXT --kind markdown --path FILE --template FILE
    [--optional] [--consumes phase/output,...]
  singularity-flow workflow phase output edit <PHASE> <OUTPUT> [--label TEXT] [--kind KIND] [--path FILE]
    [--template FILE] [--optional] [--consumes phase/output,...]
  singularity-flow workflow install <ID> [--dry-run] [--replace]   a packaged workflow
    (add and upgrade are the former names and still work)
  singularity-flow workflow validate [WORKFLOW] [--json] [--for-start]
                                                        is each workflow correct: its clause steps and plan owners, what every route
                                                        owes, and every check finding (step templates included), each located, with
                                                        why and how to fix it; exits 1 when one is not. /sf-fix-workflow in Copilot
                                                        drafts the fixes as one reviewed configuration proposal. With WORKFLOW, who
                                                        drafts, asks, reviews and approves each step, and where
  singularity-flow workflow walk [WORKFLOW] [--source repository|shipped] [--step-seconds N] [--total-seconds N] [--keep] [--json]
                                                        a model-free dry run: drives a throwaway Story through every step on an isolated
                                                        copy (stub author, stub reviewer, test approver) and lists each step's person
                                                        steps and every stop no person decision clears, with its likely cause; reads
                                                        only this repository's configuration; exits 1 on a stop, 2 when a step was not judged
  singularity-flow workflow simulate [TYPE] | diff <TYPE>
  singularity-flow workflow build start [--change ID | --from-workflow ID] [--folder DIR]... [--file FILE]... [--notes FILE|-]...
    [--describe TEXT] [--name LABEL] [--json]
                                                        start a progressive build: what a workflow or a team's material holds, each item
                                                        with its file and lines (screened, never run or fetched; kept on this computer);
                                                        --change changes that workflow in place, --from-workflow copies it
  singularity-flow workflow build start --simplify ID [--name LABEL] [--json]
                                                        a simpler copy under a new ID: each simplification it can check is offered, located
                                                        with why, for you to accept or decline; the workflow itself never changes
  singularity-flow workflow build add --build ID [--folder DIR]... [--file FILE]... [--notes FILE|-]... [--json]
  singularity-flow workflow build status [--build ID] [--json]
  singularity-flow workflow build source --build ID --path FILE [--from LINE] [--json]
  singularity-flow workflow build propose --build ID --proposal FILE|- [--by you|copilot] [--accept] [--json]
  singularity-flow workflow build decide --build ID --proposal P (--accept | --decline [--reason TEXT]) [--json]
  singularity-flow workflow build answer --build ID --question Q --choice TEXT [--json]
  singularity-flow workflow build check --build ID [--include P] [--json]
                                                        the workflow as the accepted proposals leave it: explained and checked
  singularity-flow workflow build verify --build ID [--json]
                                                        workflow validate (and workflow walk where present) on what the build would propose;
                                                        exits 1 while a problem or stop remains
  singularity-flow workflow build finish --build ID (--propose | --out FILE) [--accept-problem ID]... [--json]
                                                        one reviewed proposal through Workflow Studio's apply, or a portable bundle; a simplify
                                                        build finishes once verify finds nothing, or with each remaining one accepted by ID
  singularity-flow workflow build export --build ID --out FILE [--json]
  singularity-flow workflow build import --file FILE [--json]
                                                        move a build to another computer: export it here, import it there inside the repository
  singularity-flow workflow check [WORKFLOW] [--change-set FILE|-] [--json]
                                                        explain each workflow in plain words and list what does not make sense, with where;
                                                        with WORKFLOW, who drafts, asks, reviews and approves each step, and where
  singularity-flow workflow fix [WORKFLOW] [--answers FILE|-] [--write] [--json]
                                                        every check finding as a drafted Workflow Studio change or a question only a
                                                        person can answer (who is in a group, which route the team wants); drafts only.
                                                        --write puts the change set in the private fix draft file for workflow check
                                                        --change-set and workflow studio apply --change-set --propose; --answers turns
                                                        answered questions into changes

  # SGOS — deterministic intent compilation and governed execution
  singularity-flow intent capture <TEXT> [--out FILE] [--json]
  singularity-flow intent packet <ENVELOPE> --answers <FILE> [--out FILE] [--json]
  singularity-flow intent confirm <ENVELOPE> --answers <FILE> --confirm <PACKET-SHA256>
    --confirmed-at <RFC3339> [--out FILE] [--json]
  singularity-flow intent workflow-guide <INTENT-IR> --registry <FILE> [--json]
  singularity-flow intent workflow-create <INTENT-IR> --policy <FILE> --registry <FILE>
    --storage-profile-sha256 <SHA256> --id <LOWER-KEBAB> --operation <ID>
    --verification-operation <ID> --declaration-out <NEW-FILE> --out <NEW-FILE>
    [--title <TEXT>] [--maximum-attempts <N>] [--output-ref <REF>] [--json]
    creates only an uncommitted, unratified core candidate; does not invoke a model, ratify,
    compile, approve, commit, or run
  singularity-flow intent workflow <INTENT-IR> --policy <FILE> --declaration <FILE> [--out FILE] [--json]
  singularity-flow intent ratification-packet <INTENT-IR> --workflow <FILE> --policy <FILE>
    --registry <FILE> --storage-profile-sha256 <SHA256> [--coverage <FILE>] [--out FILE] [--json]
  singularity-flow intent ratify <INTENT-IR> --workflow <FILE> --policy <FILE> --registry <FILE>
    --storage-profile-sha256 <SHA256> [--coverage <FILE>] --confirm <PACKET-SHA256>
    --decided-at <RFC3339> [--out FILE] [--json]
  singularity-flow intent validate <FILE> [--json]
  singularity-flow intent show <FILE> [--json]
  singularity-flow intent compile <INTENT-IR> --workflow <FILE> --ratification <FILE> --policy <FILE> --registry <FILE> [--out FILE] [--json]
  singularity-flow program validate <FILE> [--json]
  singularity-flow program show <FILE> [--json]
  singularity-flow program explain <FILE> [--json]
  singularity-flow program simulate <FILE> [--json]
  singularity-flow program what-if <FILE> --without-device <ID[,ID...]> [--json]
  singularity-flow program fault-plan <FILE> --target task:<TASK-ID>|device:<DEVICE-ID>
    --failure interrupted|malformed-result|permission-denied|timeout|unavailable|verification-failed [--json]
    both commands are read-only structural analyses; they never run a Device or inject a fault
  singularity-flow program approve <FILE> [--confirm <PROPOSAL-SHA256> --approved-at <RFC3339>] [--json]
    preview first; confirmation publishes only an sflow/config review proposal, never application-branch authority
  singularity-flow process start <PROGRAM> [--compiler-request <FILE>] [--binding FILE]
    [--subject ID] [--subject-kind story|repository] [--json]
  singularity-flow process list [--json]
    show healthy Processes, Human Requests needing attention, and unavailable private state
  singularity-flow process status <PROCESS-ID> [--json]
  singularity-flow process graph <PROCESS-ID> [--json]
  singularity-flow process fsck <PROCESS-ID> [--json]
    verify indexed immutable records, pending reservations, orphans, and integrity gaps without repair
  singularity-flow process step <PROCESS-ID> [--expected-revision N] [--allow-model] [--json]
  singularity-flow process run <PROCESS-ID> [--maximum-parallel N] [--expected-revision N] [--allow-model] [--json]
    execute one deterministic ready wave; --allow-model permits proposal-only Copilot tasks
  singularity-flow process pause <PROCESS-ID> [--expected-revision N] [--json]
  singularity-flow process stop <PROCESS-ID> [--expected-revision N] [--json]
    records a durable stop by pausing dispatch; active execution must quiesce before resume
  singularity-flow process resume <PROCESS-ID> --confirm <CHECKPOINT-SHA256> [--expected-revision N] [--json]
  singularity-flow process recover <PROCESS-ID> [--json]
  singularity-flow process recover <PROCESS-ID> --attempt-id <ATTEMPT-ID>
    --resolution reconcile-success|retry-safe|fail --confirm <SHA256> [--json]
  singularity-flow process replay <PROCESS-ID> --from <CHECKPOINT-SHA256> [--confirm <REPLAY-PLAN-SHA256>] [--json]
    first records an exact confirmation plan; pure/read-only work is rerun, installed consequential effects are reconciled without repetition, and unsafe effects or stale plans are refused
  singularity-flow process fork <PROCESS-ID> --from <CHECKPOINT-SHA256>
    [--label <LOWER-KEBAB>] [--confirm <FORK-PLAN-SHA256>] [--json]
    first records an exact fork plan; non-genesis plans bind the verified successful prefix,
    consumed attempts, outputs, evidence, and installed effect postconditions before confirmation
  singularity-flow process quarantine <PROCESS-ID> [--confirm <TREE-SHA256>] [--json]
  singularity-flow process archive <PROCESS-ID> ...  # compatibility alias for quarantine
    preserve an unreadable v1 machine-local Process; preview first, never restore it as v2
  singularity-flow policy status [PROCESS-ID] [--json]
  singularity-flow policy fsck [--json]
  singularity-flow policy plan [--invalidate-process <PROCESS-ID>]... [--json]
  singularity-flow policy apply --expected-revision <N> --confirm <PLAN-SHA256>
    [--invalidate-process <PROCESS-ID>]... [--json]
    plan is read-only; apply re-reads the exact approved authority and runtime head
    an invalidated Process refuses step/run before mutation until restarted under the new policy
  singularity-flow task list <PROCESS-ID> [--json]
  singularity-flow task show <PROCESS-ID> <TASK-ID> [--json]
  singularity-flow task evidence <PROCESS-ID> <TASK-ID> [--json]
  singularity-flow task retry <PROCESS-ID> <TASK-ID> [--confirm <RETRY-PLAN-SHA256>] [--json]
  singularity-flow evidence export <PROCESS-ID> --out <REPOSITORY-FILE> [--json]
  singularity-flow evidence verify <FILE> [--json]
  singularity-flow request list [<PROCESS-ID>] [--json]
  singularity-flow request show <REQUEST-ID> [--process <PROCESS-ID>] [--json]
  singularity-flow request respond <REQUEST-ID> --process <PROCESS-ID>
    (--decision approved|rejected|provided|cancelled | --option <DECLARED-OPTION-ID>)
    [--input-json <JSON> | --sensitive-handle <NON-SECRET-HANDLE-JSON>]
    --confirm <REQUEST-SHA256> --expected-revision <PROCESS-REVISION>
    --expected-process-sha256 <PROCESS-SHA256> [--json]
  singularity-flow candidate list|show|freeze|verify|publish ... [--json]
    verify loads singularity/sgos/candidate-verifier-policy.json only from approved sflow/config authority
    legacy --commands/--timeout-ms inputs are accepted only when exactly equal to that policy
    publish first records an exact confirmation plan; repeat with --confirm <PUBLICATION-PACKET-SHA256>
  singularity-flow execution-unit list|doctor [ID|all] [--json]
  singularity-flow device list|doctor|invoke|recover|intent|result|revoke ... [--json]
    invoke and recovery read the complete typed request from --request <REPOSITORY-JSON-FILE>
    installed profiles are read-only filesystem-read and Git-common fixture-only sandbox-cas
  singularity-flow authority-store init|status|verify|recover [--store ID] [--confirm <RECOVERY-PLAN-SHA256>] [--json]
  singularity-flow authority-store trust-scaffold --mode git-trusted [--store ID] [--json]
  singularity-flow authority-store publish [--store ID] [--confirm <PUBLISH-PLAN-SHA256>] [--json]
  singularity-flow authority-store sync [--store ID] [--confirm <SYNC-PLAN-SHA256>] [--json]
  singularity-flow authority-store signer-create --signer <KEY-ID> [--store ID] [--json]
  singularity-flow authority-store export --out <REPOSITORY-FILE> --signer <KEY-ID> [--store ID] [--json]
  singularity-flow authority-store inspect|import <REPOSITORY-FILE> [--store ID] [--confirm <IMPORT-PLAN-SHA256>] [--json]
  singularity-flow authority-store rollback --receipt <CUTOVER-SHA256> [--store ID] [--confirm <ROLLBACK-PLAN-SHA256>] [--json]
    transport trust comes only from approved singularity/sgos/capability-pack-trust.json
    v3 git-trusted publishes/syncs through the exact configured state branch without a transport key
    v3 requires an approved reachable remote/state branch and architecture-reviewers identity for sync
    offline root binding is signed-v2 only; v3 sync/rollback cannot cross minimumAuthority
    runtime reads Pack lineage locally and never auto-syncs state; only explicit sync refreshes the Store
    retain Pack publisher public keys for history; revoke/supersede Packs instead of removing keys
    v2 signed transport remains available when Git-host compromise must not be trusted
    import and rollback preview first; no command merges or silently rewinds Authority Store history
  singularity-flow pack list|active|show|propose|review|activate|revoke ... --trust <PUBLIC-TRUST-JSON> [--json]
  singularity-flow learn list|show ... --role <ROLE> [--pack <PACK-ID>] --trust <PUBLIC-TRUST-JSON> [--json]
  singularity-flow learn start|inspect <LESSON-ID> --role <ROLE> --module <LEARNING-MODULE.json>
    [--pack <PACK-ID>] --trust <PUBLIC-TRUST-JSON> [--json]
  singularity-flow learn materialize <LESSON-ID> --role <ROLE> --module <LEARNING-MODULE.json>
    --fixture <LEARNING-FIXTURE.json> [--pack <PACK-ID>] --trust <PUBLIC-TRUST-JSON>
    [--confirm <PLAN-SHA256>] [--json]
  singularity-flow learn bundle-create <LESSON-ID> --role <ROLE> --module <LEARNING-MODULE.json>
    --fixture <LEARNING-FIXTURE.json> [--pack <PACK-ID>] --trust <PUBLIC-TRUST-JSON>
    --out <NEW-BUNDLE.json> [--json]
  singularity-flow learn bundle-inspect --bundle <BUNDLE.json> [--json]
  singularity-flow learn bundle-materialize --bundle <BUNDLE.json> --trust <PUBLIC-TRUST-JSON>
    [--confirm <PLAN-SHA256>] [--json]
  singularity-flow learn workspace <MISSION-SHA256> [--json]
  singularity-flow learn progress|progress-export <MISSION-SHA256> [--json]
  singularity-flow learn check <LESSON-ID> <CHECK-ID> --role <ROLE>
    --module <LEARNING-MODULE.json> --answers <ANSWER.json>
    [--pack <PACK-ID>] --trust <PUBLIC-TRUST-JSON> [--json]
  singularity-flow learn progress-import --transfer <IDENTITY-FREE-TOKEN>
    [--confirm <PLAN-SHA256>] [--json]
  singularity-flow learn reset <MISSION-SHA256> [--confirm <PLAN-SHA256>] [--json]
  singularity-flow learn explain-change <LESSON-ID> <STEP-ID> --role <ROLE> --module <LEARNING-MODULE.json>
    [--pack <PACK-ID>] --trust <PUBLIC-TRUST-JSON> [--json]
  singularity-flow learn quiz|teach-back <LESSON-ID> <CHECK-ID> --role <ROLE>
    --module <LEARNING-MODULE.json> --answers <ANSWER.json>
    [--pack <PACK-ID>] --trust <PUBLIC-TRUST-JSON> [--json]
  singularity-flow memory inspect|dependencies|register|promote ... [--store ID] [--json]
  singularity-flow meta-tool list|propose|evaluation|promote ... [--store ID] [--json]
  singularity-flow meta-tool activate --store ID --trace-trust FILE --evaluator-trust FILE
    --candidate-sha256 SHA256 --evaluation-sha256 SHA256 --promotion-sha256 SHA256
    [--target-kind pack-operation|device-operation] --domain DOMAIN [--device DEVICE]
    --operation OPERATION --maximum-observations N --maximum-evidence-refs N
    --accepted-outcomes degraded,failed,succeeded [--confirm PLAN-SHA256] [--json]
  singularity-flow meta-tool observe --store ID --trace-trust FILE --evaluator-trust FILE
    --activation-sha256 SHA256 --outcome OUTCOME --evidence-refs SHA256[,SHA256]
    [--confirm PLAN-SHA256] [--json]
  singularity-flow meta-tool revoke --store ID --trace-trust FILE --evaluator-trust FILE
    --activation-sha256 SHA256 --reason TEXT [--confirm PLAN-SHA256] [--json]
  singularity-flow meta-tool rollback --store ID --trace-trust FILE --evaluator-trust FILE
    --operation OPERATION --target-activation-sha256 SHA256 --reason TEXT
    [--confirm PLAN-SHA256] [--json]
    activate/observe/revoke/rollback always preview without --confirm and bind confirmation to exact CAS state
    activation resolves Pack targets only from the current signed Pack in approved capability-pack-trust authority
    a Device target must be installed, non-revoked, and exported as device:<device>:<operation> by that current signed Pack
    arbitrary target files and caller-supplied Device manifests are not accepted by this CLI
    private keys, secrets, credentials and tokens are never accepted in command arguments
  singularity-flow assign <PHASE> <ASSIGNEE>
  singularity-flow watch [WORK-ID] [--once] [--fetch] [--interval SECONDS] [--json]
  singularity-flow recover [WORK-ID] [--phase PHASE] [--fetch] [--apply | --commit-reviewed | --set-aside --confirm PLAN-HASH] [--json]
  singularity-flow inputs [PHASE] [--dry-run]
  singularity-flow inputs restore [PHASE] [--confirm PLAN-SHA256] [--json]
    previews, then restores, the exact approved bytes of an earlier phase's input or artifact that
    changed or vanished in the working tree only; saves a private checkpoint first; never stages,
    commits or edits Story state; committed drift is refused with the earlier phase's route
  singularity-flow spec analyze [--phase PHASE] [--work-id ID] [--assisted [--model NAME] [--refresh]] [--json]
  singularity-flow spec index [ARTIFACT] [--phase PHASE] [--work-id ID] [--dry-run] [--json]
  singularity-flow spec claims planned --file JSON_OR_YAML [--phase PHASE] [--json]
  singularity-flow spec coverage [--base REF] [--target REF] [--json]
  singularity-flow spec acceptance [--command ID]... [--phase PHASE] [--dry-run] [--json]
  singularity-flow spec tasks [--phase PHASE] [--work-id ID] [--dry-run] [--json]
  singularity-flow spec trace [CLAUSE-ID] [--format human|json|csv]
  singularity-flow spec drift [--work-id WORK-ID] [--ref REV] [--all] [--json]
  singularity-flow spec drift decide CLAUSE-ID (--accept | --adopt --story WORK-ID | --restore --story WORK-ID) --reason TEXT [--json]
  singularity-flow spec drift decide --revoke DRD-ID --work-id WORK-ID --reason TEXT [--json]
  singularity-flow spec author new [SPEC-ID] [--title TEXT] [--kind business|technical] [--intent TEXT | --from FILE] [--area PATH]... [--json]
  singularity-flow spec author new SPEC-ID --revise [--title TEXT] [--json]
  # New drafts get a unique ID automatically; use the returned specId for later commands.
  singularity-flow spec author edit SPEC-ID (--file FILE [--title TEXT] [--kind business|technical] | --title TEXT | --kind business|technical) --expected-seq N [--json]
  singularity-flow spec author research SPEC-ID [--path PATH]... [--symbol NAME]... [--refresh] [--json]
  singularity-flow spec author research SPEC-ID (--fact TEXT --source NAME | [--remove R-NNN]...) [--json]
  singularity-flow spec author gap SPEC-ID --kind KIND --question TEXT [--research R-NNN,...] [--clause ID]...
    [--options FILE] [--json]
  singularity-flow spec author gaps SPEC-ID [GAP-ID] [--json]
  singularity-flow spec author decide SPEC-ID GAP-ID (--option ON | --choice TEXT | --defer --owner NAME | --reopen)
    --reason TEXT [--json]
  singularity-flow spec author propose SPEC-ID --file FILE [--json]
    stage Copilot's proposals (edit, research, gap) and assisted checklist findings; nothing is in the draft until accepted
  singularity-flow spec author accept SPEC-ID P-NNN... [--edit FILE] [--json] | reject SPEC-ID P-NNN... --reason TEXT [--json]
  singularity-flow spec author settle SPEC-ID ([--article ARTICLE=DECISION]... | --all-articles DECISION | [--finding A-NNN=gap|fixed|dismissed]...)
    [--reason TEXT] [--json]
    repeat --article or --finding once per value, or give one comma-separated list; a value without its flag is refused
  singularity-flow spec author sync SPEC-ID [--automatic --min-interval-ms N] [--json]
  singularity-flow spec author shared [SPEC-ID] [--refresh] [--json]
  singularity-flow spec author resume SPEC-ID --checkpoint SHA256 --expected-seq N [--json]
  singularity-flow spec author history SPEC-ID [--sequence N | --retention] [--json]
  singularity-flow spec author restore-version SPEC-ID --sequence N --expected-seq N [--json]
  singularity-flow spec author fork SPEC-ID [--file FILE] [--json]
  singularity-flow spec author derive SPEC-ID@N [--parent SPEC-ID@N]... [--json]
  singularity-flow spec author source SPEC-ID (--file FILE... | --url URL | --path CODE | --specification SPEC-ID@N | --remove SRC-ID) [--restore SRC-ID] [--json]
  singularity-flow spec author sources SPEC-ID[@N] [--source SRC-ID --from LINE --column N --max-bytes N] [--json]
  singularity-flow spec author screen --file FILE [--json]
    answers withhold secret-shaped values; a person's own view adds --for-person, which an agent is refused
    shared drafts are unreviewed checkpoints; local files/images never go into Git;
    resume compares exact versions and retains local history; derive pins a reviewed parent's requirements
  singularity-flow spec author check SPEC-ID [--json] | status SPEC-ID [--quick] [--json]
  singularity-flow spec author publish SPEC-ID (--reviewed | --draft) [--expected-seq N] [--json]
  singularity-flow spec author show SPEC-ID[@N] [--any] [--json] | list [--local] [--json] | discard SPEC-ID [--json]
    saves accept --operation-id ID; reuse the same ID to reconcile an interrupted operation
    the specification library: one draft per specification on this clone, research cited from the
    code, gaps a person decides, a check with no model, immutable revisions on the state branch;
    accepting, rejecting, deciding, settling, publishing and discarding are the person's own steps; writes take --operation-id ID
  singularity-flow spec author coverage SPEC-ID@N [--repair --story WORK-ID] [--json]
    per clause of one revision: delivered, claimed, allocated by a split, left out or uncovered, and
    each child of a split whose parent clause changed since ("parent moved"), from one state commit;
    --repair writes the usage records a Story's committed approval or closing proves
  singularity-flow spec split SPEC-ID@N [--propose --file FILE | --publish] [--json]
    divide a reviewed revision among child specifications and Story slices: every clause allocated or
    left out with its reason, no cycle between slices; --propose checks a JSON or YAML plan and keeps it
    on this clone, --publish (the person's own step) publishes it to the state branch, drafts each child
    here and lists one start command per slice; no Story is started
  singularity-flow spec attach WORK-ID --drop CLAUSE-ID --reason TEXT [--json]
    take one clause out of the slice a Story started with (start --spec): its scope item is recorded
    excluded with the reason, by a person who decides the Story's scope; the person's own step
  singularity-flow evidence matrix [WORK-ID] [--row ID] [--result RESULT] [--facet NAME[=VALUE]]
    [--page N] [--page-size N] [--format human|json|csv]
    one row per requirement and acceptance criterion with its plan, implementation, verification,
    result and assurance; read-only, runs no test and makes no network call
  singularity-flow evidence scope [WORK-ID] [--json]
    every requirement statement in the Story's sources with its disposition, and every source that
    could not be read; read-only
  singularity-flow comprehension regions [--work-id WORK-ID] [--phase PHASE] [--base REVISION] [--json]
  singularity-flow comprehension source <SFREF> [--offset BYTES] [--max-bytes BYTES]
    [--work-id WORK-ID] [--phase PHASE] [--base REVISION] [--json]
  singularity-flow comprehension brownfield [--work-id WORK-ID] [--phase PHASE] [--base REVISION] [--json]
  singularity-flow comprehension backfill validate <PROPOSAL-FILE> [--work-id WORK-ID]
    [--phase PHASE] [--base REVISION] [--json]
  singularity-flow comprehension check [--work-id WORK-ID] [--phase PHASE] [--base REVISION]
    [--bindings REPOSITORY-FILE] [--dispositions REPOSITORY-FILE] [--json]
  singularity-flow comprehension graph [--work-id WORK-ID] [--phase PHASE] [--base REVISION]
    [--bindings REPOSITORY-FILE] [--dispositions REPOSITORY-FILE] [--json]
  singularity-flow comprehension explain clause|file|symbol|change|refusal|generation|test <SUBJECT>
    [--work-id WORK-ID] [--phase PHASE] [--base REVISION] [--bindings REPOSITORY-FILE] [--json]
  singularity-flow comprehension replay [all|phase <PHASE>|kind <EVENT-KIND>]
    --work-id WORK-ID [--json]
  singularity-flow comprehension walkthrough draft [--work-id WORK-ID] [--phase PHASE]
    [--base REVISION] [--json]
  singularity-flow comprehension walkthrough validate <DRAFT-FILE> [--work-id WORK-ID]
    [--phase PHASE] [--base REVISION] [--bindings FILE] [--dispositions FILE] [--json]
  singularity-flow comprehension walkthrough revalidate <DRAFT-FILE> <PREVIOUS-VALIDATION-FILE>
    [--work-id WORK-ID] [--phase PHASE] [--base REVISION] [--bindings FILE]
    [--dispositions FILE] [--json]
  singularity-flow change show [WORK-ID] --shadow [--proof-profile standard|high-assurance|regulated|custom-registered] [--json]
  singularity-flow proof status|gaps|signals [WORK-ID] [--proof-profile standard|high-assurance|regulated|custom-registered] [--json]
  singularity-flow proof explain [WORK-ID] <PREDICATE-ID> [--proof-profile standard|high-assurance|regulated|custom-registered] [--json]
  singularity-flow delivery recommend --request-file FILE [--json]
  singularity-flow delivery select --plan FILE --confirm-plan SHA256 --mode outcome [--json]
  singularity-flow delivery workflow-status [WORK-ID] [--proof-profile PROFILE] [--json]
  singularity-flow delivery execution-status <PROCESS-ID> [--work-id WORK-ID] [--proof-profile PROFILE] [--json]
  singularity-flow delivery promotion-preview <SESSION-ID> --workflow feature|bugfix --work-id WORK-ID [--json]
  singularity-flow delivery promotion-apply --plan FILE --confirm-plan SHA256 [--json]
  singularity-flow delivery promotion-status <SESSION-ID> [--json]
  singularity-flow delivery assurance-evaluate --evidence-file FILE [--json]
  singularity-flow delivery provenance-status [--provider-file FILE] [--json]
  singularity-flow delivery authenticated-runner-status [--runner-provider-file FILE] [--json]
  singularity-flow delivery local-runner-create --signer ID [--json]
  singularity-flow delivery local-runner-status --signer ID [--json]
  singularity-flow delivery local-runner-options [--work-id WORK-ID] [--json]
  singularity-flow delivery local-runner-plan --signer ID --work-id WORK-ID --phase PHASE --command ID --proof-subject SHA256 --candidate SHA256 [--json]
  singularity-flow delivery local-runner-run (--plan FILE | --signer ID --work-id WORK-ID --phase PHASE --command ID --proof-subject SHA256 --candidate SHA256) --confirm-plan SHA256 [--json]
  singularity-flow delivery local-runner-verify --attestation-file FILE --signer ID [--json]
  singularity-flow delivery readiness [--provider-file FILE] [--runner-provider-file FILE] [--json]
  singularity-flow agents list
  singularity-flow agents create <ID> --label TEXT --description TEXT [--role ROLE] [--from-agent AGENT] [--tools a,b] [--instructions TEXT | --from FILE] [--step STEP,...] [--operation-id ID] [--dry-run | --propose] [--json]
  singularity-flow agents edit <ID> [--label TEXT] [--description TEXT] [--tools a,b] [--instructions TEXT | --from FILE] [--step STEP,...] [--operation-id ID] [--dry-run | --propose] [--json]
    --step makes the agent the one that drafts those steps, in the same change: the agent and its steps are saved, proposed and approved together
  singularity-flow agents mappings
  singularity-flow agents lock <PACK> [--update]
  singularity-flow agents sync <PACK>
  singularity-flow agents status [PACK]
  singularity-flow agents refresh-output <RESOURCE-ID> [--replace]
  singularity-flow import preview <LINK|market:ID/ENTRY[@VERSION]|mcp:SERVER/prompt|resource|tool/NAME> [--as skill|template|agent|mcp-server] [--id ID] [--max-bytes N] [--launch] [--arg NAME=VALUE]... [--json]
  singularity-flow import add <LINK> --as skill --agent AGENT [--id ID] [--phases A,B] [--optional] --sha256 HASH [--replace] [--dry-run] [--propose] [--json]
  singularity-flow import add <LINK> --as skill [--id ID] [--description TEXT] --sha256 HASH [--replace] [--dry-run] [--propose] [--json]
                                                        into the skill master; plain Markdown needs --description
  singularity-flow import add <LINK> --as template [--id ID] [--label TEXT] [--phases A,B] --sha256 HASH [--replace] [--dry-run] [--propose] [--json]
  singularity-flow import add <LINK> --as agent [--without-defaults] --sha256 HASH [--replace] [--dry-run] [--propose] [--json]
  singularity-flow import add <LINK|market:ID/ENTRY> --as mcp-server [--agents A,B] [--phases A,B] --sha256 HASH [--replace] [--dry-run] [--propose] [--json]
  singularity-flow import add --as generated --agent AGENT --id ID --url-template URL --phase PHASE --target artifacts/PHASE/FILE.md [--optional] [--dry-run] [--propose] [--json]
  singularity-flow imports [list] [--json]
  singularity-flow imports check [--json]
  singularity-flow imports remove <IMPORT> [--dry-run] [--propose] [--json]
  singularity-flow marketplace [list] [--json]
  singularity-flow marketplace browse <ID> [--kind KIND] [--search TEXT] [--json]
  singularity-flow marketplace add <ID> --index URL [--label TEXT] [--allowed-origin URL]... [--dry-run] [--propose] [--json]
  singularity-flow marketplace remove <ID> [--dry-run] [--propose] [--json]
  singularity-flow apm status [--json]
  singularity-flow apm install [PACKAGE]... [--dev] [--dry-run] [--json]
  singularity-flow apm update [PACKAGE]... [--dry-run] [--json]
  singularity-flow apm attach <AGENT> --step STEP [--dry-run] [--propose] [--json]
  singularity-flow apm marketplace init --name NAME --owner OWNER [--description TEXT] [--dry-run] [--json]
  singularity-flow apm publish <AGENT>... --marketplace CHECKOUT [--package NAME] [--version X.Y.Z] [--skill ID]... [--description TEXT] [--dry-run] [--json]
  singularity-flow apm policy init --marketplace OWNER/REPOSITORY... [--allow PATTERN]... [--name TEXT] [--enforcement block|warn] [--dry-run] [--json]
  singularity-flow index status|refresh|rebuild [--all] [--json]
  singularity-flow index verify [--authority] [--all] [--json]
  singularity-flow lock show <KIND> <ID> [--json]
  singularity-flow lock release <KIND> <ID> --confirm <LOCK-TOKEN> [--json]
  singularity-flow lock show-file <LEASE-FILE> [--json]
  singularity-flow lock release-file <LEASE-FILE> --confirm <TOKEN> [--json]
  singularity-flow backup create --out <DIRECTORY> [--json]
  singularity-flow backup inspect <DIRECTORY> [--json]
  singularity-flow backup restore <DIRECTORY> [--json]
  singularity-flow findings template [--out FILE] [--json]
  singularity-flow prompts [--story ID] [--limit N] [--json]
  singularity-flow findings import FILE [--feed security|tlm] [--source NAME] [--dry-run] [--json]
  singularity-flow findings list [--feed security|tlm] [--state active|all|STATE] [--all-repositories] [--limit N] [--json]
  singularity-flow findings link <WORK-ID> --address ID,... [--json]
  singularity-flow findings plan [--feed security|tlm] [--all-repositories] [--json]
  singularity-flow findings start <GROUP-ID> [--work-id ID] [--from-branch BRANCH] [--fetch] [--isolated-worktree] [--json]
  singularity-flow findings report [--out FILE] [--feed security|tlm] [--all-repositories] [--json]
  singularity-flow git-policy discover|show [--json]
  singularity-flow git-policy plan|validate --operation sha256:<OWNER-ISSUED-ID> [--json]
  singularity-flow guard status [--json]
  singularity-flow guard reconcile [--json]
  singularity-flow guard report [--since DATE|7d|12h] [--story WORK-ID] [--json]
  singularity-flow guard remote-check [--recipe] [--package-url URL --package-sha256 HEX] [--json]
  singularity-flow guard register [--key SHA256:...] [--propose] [--json]
  singularity-flow guard rotate|recover --key SHA256:... [--propose] [--json]
  singularity-flow guard revoke <APPROVER-ID> --reason TEXT [--propose] [--json]
  singularity-flow guard enable [--remote-check NAME] [--exception APPROVER-ID]... [--propose] [--json]
  singularity-flow guard disable --reason TEXT [--propose] [--json]
  singularity-flow guard exception add <APPROVER-ID> [--reason TEXT] [--host-review] | guard exception revoke <EXC-ID> --reason TEXT [--propose] [--json]
  singularity-flow guard stamp-agents [--propose] [--json]
  singularity-flow mcp list|status|doctor [--json]
  singularity-flow mcp scaffold playwright|figma [--local] [--replace-server]
  singularity-flow mcp doctor [--server ID] [--network] [--json]
  singularity-flow mcp sources [SERVER] [--launch] [--json]
  singularity-flow mcp host add <SERVER> [--replace-server] [--json]
  singularity-flow mcp probe <SERVER> --network [--json]
  singularity-flow mcp warm <SERVER> --network
  singularity-flow mcp verify-offline <SERVER> [--json]
  singularity-flow mcp serve playwright
  singularity-flow mcp auth status playwright [--json]
  singularity-flow mcp auth import playwright --storage-state FILE --profile LOWER-KEBAB [--confirm SHA256] [--json]
  singularity-flow mcp auth remove playwright --profile LOWER-KEBAB --confirm SHA256 [--json]
  singularity-flow mcp auth clear playwright [--confirm SHA256] [--json]
  singularity-flow mcp attest <SERVER> --confirm <SERVER>
  singularity-flow mcp smoke <SERVER> --url AUTHORIZED-URL [--phase PHASE] [--json]
  singularity-flow mcp record <SERVER> --tool TOOL [--kind tool-call|design-source|visual-artifact]
    [--phase PHASE] [--target-url AUTHORIZED-URL] [--output PATH|--output-url HTTPS-URL] [--file-key KEY] [--file-version VERSION] [--node NODE] [--note TEXT]
  singularity-flow mcp design-sources status [--json]
  singularity-flow mcp design-sources promote <RECORD-ID> --confirm <RECORD-ID> [--reason TEXT]
  singularity-flow visual status [--json]
  singularity-flow visual compare --expected RECORD-OR-PATH --actual RECORD-OR-PATH [--profile ID] [--json]
  singularity-flow visual record --phase VISUAL-STEP --profile-id ID --screen-id ID --state-id ID --file PNG-PATH
    --source simulator|emulator|device --device NAME [--os-version VERSION] [--note TEXT] [--json]
  singularity-flow wm design-inventory --from-records [--json]
  singularity-flow documents list [WORK-ID] [--phase PHASE] [--active|--all] [--json]
  singularity-flow documents artifacts [ARTIFACT-ID] [--version draft|approved] [--work-id ID] [--json]
  singularity-flow documents view <DOCUMENT-ID|NAME|PATH> [--work-id ID] [--all] [--json]
  singularity-flow documents preview <DOCUMENT-ID|NAME|PATH> [--work-id ID] [--json]
  singularity-flow documents upload <FILE-OR-DIRECTORY...> --name TEXT... [--phases PHASE,...|all] [--store git|local] [--kind KIND] [--json]
  singularity-flow documents upload --url URL --name TEXT [--phases PHASE,...|all] [--json]
  singularity-flow documents browse --provider ID [--path PATH] [--json]
  singularity-flow documents fetch <ITEM-ID> --provider ID --name TEXT [--filename FILE] [--phases PHASE,...|all] [--store git|local] [--json]
  singularity-flow documents fetch <ATTACHMENT-ID> --provider jira [--name TEXT] [--phases PHASE,...|all] [--store git|local] [--json]
  singularity-flow documents fetch <SRC-ID> --provider epic [--name TEXT] [--phases PHASE,...|all] [--store git|local] [--json]
  singularity-flow documents scope <DOCUMENT-ID|NAME> --phases PHASE,...|all --reason TEXT [--scope file|package] [--dry-run] [--yes] [--json]
  singularity-flow documents detach <DOCUMENT-ID|NAME> [--scope file|package] --reason TEXT [--dry-run] [--yes]
  singularity-flow documents store <DOCUMENT-ID|NAME> --store git [--json]
  singularity-flow documents readiness [--phase PHASE] [--work-id ID] [--json]
  singularity-flow documents restore <DOCUMENT-ID|NAME> --file LOCAL-FILE [--work-id ID] [--json]
  singularity-flow revision activation [--json]
  singularity-flow revision capabilities [--json]
  singularity-flow revision status [--json]
  singularity-flow revision card [INTERVAL-ID] [--json]
  singularity-flow revision show <INTERVAL-ID> [--json]
  singularity-flow revision checks capabilities [--json]
  singularity-flow revision checks plan [--json]
  singularity-flow revision checks status [RUN-ID] [--json]
  singularity-flow revision checks result <RUN-ID> [--json]
  singularity-flow revision checks run --plan SHA256 --confirm SHA256 [--json]
  singularity-flow revision resume [INTERVAL-ID] [--json]
  singularity-flow revision capture --preview --note TEXT --saved-buffers-confirmed [--json]
  singularity-flow revision capture --note TEXT --saved-buffers-confirmed --plan SHA256 --confirm SHA256 [--json]
  singularity-flow revision abandon <LOOP-ID|INTERVAL-ID> --preview [--json]
  singularity-flow revision abandon <LOOP-ID|INTERVAL-ID> --plan SHA256 --confirm SHA256 [--json]
  singularity-flow revise --dry-run --feedback-stdin --saved-buffers-confirmed [--criteria CLAUSE-ID] [--disposition RESULT] [--attachment-set SHA256] [--json]
  singularity-flow revise --feedback-stdin --saved-buffers-confirmed [--criteria CLAUSE-ID] [--disposition RESULT] [--attachment-set SHA256] --confirm SHA256 [--json]
  singularity-flow revision attachments capabilities [--json]
  singularity-flow revision attachments preview --file LOCAL-FILE [--file LOCAL-FILE...] [--select NUMBER...] [--line-range NUMBER:START-END...] (--feedback-stdin | --feedback TEXT) [--json]
  singularity-flow revision attachments register --file LOCAL-FILE [--file LOCAL-FILE...] [--select NUMBER...] [--line-range NUMBER:START-END...] (--feedback-stdin | --feedback TEXT) --confirm SHA256 [--idempotency-key KEY] [--json]
  singularity-flow revision attachments list [--json]
  singularity-flow revision attachments status [--json]
  singularity-flow revision attachments remove-preview --attachment-set SHA256 [--json]
  singularity-flow revision attachments remove --confirm SHA256 [--idempotency-key KEY] [--json]
  singularity-flow prepare [PHASE]
  singularity-flow clarification status [PHASE] [--json]
  singularity-flow clarification answer [PHASE] (--question TEXT | --marker TEXT) --answer TEXT [--why TEXT] [--json]
  singularity-flow clarification import [PHASE] [--json]
  singularity-flow clarification record [PHASE] (--question TEXT --answer TEXT | --marker TEXT --answer TEXT | --response-file FILE)
    [--why TEXT] [--status answered|deferred] [--blocking] [--owner TEXT] [--impact TEXT] [--replace]
  singularity-flow phase show [PHASE] [--json] [--for-agent]
  singularity-flow phase enter [PHASE] [--work-id WORK-ID] [--compose] [--for-agent] [--json]
  singularity-flow phase draft-check [PHASE] [--json]
  singularity-flow phase prepublish [PHASE] [--json] [--for-agent] [--publish-if-ready]
  singularity-flow phase begin [PHASE] [--json]
    [--adopt-existing|--adopt-current-interval] [--confirm CHANGE-SET-DIGEST]
  singularity-flow phase rollover [PHASE] [--reason TEXT] [--json|--confirm CURRENT-DIGEST]
  singularity-flow phase publish [PHASE]
    [--authored human|governed-agent|deterministic|external-tool]
    [--from FILE] [--channel manual-in-place|manual-import|copilot-host|kernel-model|kernel-generator|external-tool]
    [--external-ai none|assisted] [--change-origin ORIGIN...] [--usage-json FILE]
  singularity-flow artifact add <PATH...> [--kind KIND] [--phase PHASE]
  singularity-flow artifact scan [--phase PHASE]
  singularity-flow pr describe [WORK-ID] [--format markdown|json] [--clipboard] [--write] [--yes]
  singularity-flow pr [WORK-ID] [--json] [--create] [--yes]
  singularity-flow submit [PHASE] [--work-id WORK-ID] [--phase PHASE] [--skip-checks]
    [--decision NAME=VALUE]...
  singularity-flow approve [PHASE] [--work-id WORK-ID] [--fetch] [--phase PHASE] [--yes]
    [--confirm-evidence [--evidence-reason TEXT]]   (also records each open visual or inspection witness this approver may give)
    [--article ID=satisfied|exception|not-applicable]... [--article-reason TEXT]... [--checklist FILE]
    [--witness-mapping WITNESS=satisfied|exception:FACET[,FACET]|not-applicable]...
    [--witness-mapping-reason TEXT]... [--witness-mapping-expires YYYY-MM-DD]...
    [--binding CLAUSE=accept|exception]... [--binding-reason TEXT]...
    [--choose ITEM=OPTION [--reason ITEM=TEXT] [--expires ITEM=YYYY-MM-DD] [--cause ITEM=TEXT]]... [--decisions sha256:DIGEST]
  singularity-flow reject [PHASE] [--work-id WORK-ID] [--fetch] --reason TEXT [--to PHASE] [--clause ID]...
  singularity-flow decision show [WORK-ID] [--json]
  singularity-flow decision choose [WORK-ID] [--fetch] (--option ID | --to PHASE|end) --reason TEXT [--expected KEY] [--json]
  singularity-flow decision applicability [WORK-ID] [--fetch] --responsibility scope|plan|implement|verify|review --reason TEXT [--json]
  singularity-flow decision completeness [WORK-ID] [--fetch] --confirm INVENTORY-SHA256 --article ID=satisfied|exception|not-applicable... [--article-reason TEXT]... [--checklist FILE] --reason TEXT [--json]
  singularity-flow decision plan [WORK-ID] [--fetch] (--add-location CLAUSE=PATH | --add-supporting PATH=CLASS [--supporting-reason TEXT])... --reason TEXT [--json]
  singularity-flow decision departure [WORK-ID] [--fetch] --departure DEP-ID [--departure DEP-ID]... --as accepted|rejected [--clause CLAUSE] --reason TEXT [--json]
  singularity-flow decision plan [WORK-ID] [--fetch] [--owner PHASE] (--add-row CLAUSE=PATH[,PATH] [--test PATH]... [--fulfillment KIND] [--steps STEP,...] | --remove-row CLAUSE | --set-fulfillment CLAUSE=KIND | --add-test CLAUSE=PATH | --remove-test CLAUSE=PATH | --replace-test CLAUSE=FROM:TO | --remove-location CLAUSE=PATH | --replace-location CLAUSE=FROM:TO)... --reason TEXT [--upstream-issue UPI-ID] [--dry-run] [--json]
  singularity-flow decision risk [WORK-ID] [--fetch] (--obligation OBL-ID --category CATEGORY --expires YYYY-MM-DD [--transition terminal] | --revoke RISK-ID) --reason TEXT [--json]
  singularity-flow decision test-risk [WORK-ID] [--fetch] (--phase PHASE [--command ID [--cause-class CLASS] [--argv-sha256 DIGEST]] --cause TEXT --expires YYYY-MM-DD | --revoke TRR-ID) --reason TEXT [--json]
  singularity-flow decision test-command [WORK-ID] (--phase PHASE (--use SUGGESTION-ID | --id ID --argv JSON ... | --repin COMMAND-ID) | --accept TCD-ID | --revoke TCD-ID) --reason TEXT [--json]
  singularity-flow decision test-narrowing [WORK-ID] [--fetch] (--phase PHASE [--command ID] [--expires YYYY-MM-DD] | --revoke TNR-ID) --reason TEXT [--json]
  singularity-flow decision finding-risk [WORK-ID] (--phase PHASE --finding F-ID --expires YYYY-MM-DD | --revoke FRK-ID) --reason TEXT [--json]
  singularity-flow decision evidence-reuse [WORK-ID] [--fetch] (--phase PHASE --from-attempt TA-ID [--expires YYYY-MM-DD] | --revoke ERU-ID) --reason TEXT [--json]
  singularity-flow decision visual-profile [WORK-ID] [--fetch] (--phase VISUAL-STEP --profile PROFILE-ID --not-applicable | --revoke VPD-ID) --reason TEXT [--json]
  singularity-flow decision witness-exception [WORK-ID] [--fetch] --phase STEP --mapping sha256:... --expires YYYY-MM-DD --reason TEXT [--json]
  singularity-flow decision witness [WORK-ID] [--fetch] --criterion AC-ID --slot SLOT --file PATH (--confirm ITEM | --deny ITEM)... --reason TEXT [--json]
  singularity-flow decision witness-defer [WORK-ID] [--fetch] --criterion AC-ID --slot SLOT --to STEP --reason TEXT [--json]
  singularity-flow decision visual-risk [WORK-ID] [--fetch] --comparison VISUAL-ID --expires YYYY-MM-DD --reason TEXT [--json]
  singularity-flow decision scope [WORK-ID] [--fetch] --item SRI-ID|DOC-ID --as included|existing|excluded|deferred|informative|duplicate|superseded [--clause ID,...] --reason TEXT [--json]
  singularity-flow decisions [WORK-ID] [--phase PHASE] [--choose ITEM=OPTION [--reason ITEM=TEXT] [--expires ITEM=YYYY-MM-DD] [--cause ITEM=TEXT]]... [--json]
  singularity-flow decisions record [WORK-ID] [--phase PHASE] (--choose ITEM=OPTION [--reason ITEM=TEXT] [--expires ITEM=YYYY-MM-DD] [--cause ITEM=TEXT]... [--confirm sha256:DIGEST] | --answers FILE) [--fetch] [--json]
  singularity-flow decisions undo [WORK-ID] --settled STL-ID [--reason TEXT] [--fetch] [--json]
  singularity-flow gateway serve --transport stdio [--workspace WORKSPACE]
  singularity-flow gateway tools [--json]
  singularity-flow gateway events [--json] [--host HOST] [--operation ID] [--outcome STATUS] [--reason CODE] [--subject ID] [--correlation ID]
  singularity-flow gateway session [show|reset] [--workspace WORKSPACE] [--json]
  singularity-flow call add FOLDER [--name ID] [--label TEXT] [--main FILE] [--output code|document] [--approval-group ID] [--replace] [--confirm sha256:PLAN] [--json]
  singularity-flow call list|show NAME [--json]
  singularity-flow upstream-issue raise --phase EARLIER --about ID|SECTION --problem TEXT [--assumption TEXT] [--impact TEXT] [--proposed KIND] [--authored human|governed-agent] [--supersedes UPI-ID] [--work-id WORK-ID] [--json]
  singularity-flow upstream-issue raise --from-artifact [--work-id WORK-ID] [--json]
  singularity-flow upstream-issue list [--open] [--work-id WORK-ID] [--json]
  singularity-flow upstream-issue decide UPI-ID --outcome plan-correction|amend|return|accept-risk|dismiss --reason TEXT [--link PRC-ID|FAM-ID] [--expires YYYY-MM-DD] [--work-id WORK-ID] [--json]
  singularity-flow upstream-issue propose-amendment --phase EARLIER --reason TEXT [--file DRAFT] [--issue UPI-ID] [--work-id WORK-ID] [--json]
  singularity-flow upstream-issue decide-amendment FAM-ID --decision approve|reject --reason TEXT --confirm FAM-ID [--work-id WORK-ID] [--json]
  singularity-flow upstream-issue revalidate PHASE --amendment FAM-ID|AMD-ID --outcome unchanged|return --reason TEXT [--work-id WORK-ID] [--json]
  singularity-flow departure record --kind path|supporting|plan-row|test|wording|clause|finding --reason TEXT [--path FILE]... [--clause CLAUSE]... [--row-op OP] [--target STEP --file DRAFT] [--finding ID]... [--supersedes DEP-ID] [--work-id WORK-ID] [--json]
  singularity-flow departure account --instruction N (--clauses ID,... | --departure DEP-ID) [--work-id WORK-ID] [--json]
  singularity-flow departure list [--phase PHASE] [--open] [--work-id WORK-ID] [--json]
  singularity-flow departure show DEP-ID [--work-id WORK-ID] [--json]
  singularity-flow reopen [WORK-ID] [--fetch] --reason TEXT --to PHASE
  singularity-flow cancel [WORK-ID] [--fetch] --reason TEXT --confirm WORK-ID
  singularity-flow sync [WORK-ID] [--replay [--dry-run]] [--rebind-remote sha256:...] [--json]
  singularity-flow sync [WORK-ID] --set-aside [--confirm COMMIT] [--json]
  singularity-flow sync <INTENT-ID> [--json]
  singularity-flow validate [--strict]
  singularity-flow gate [--terminal] [--json]
  singularity-flow wm compose [--agent ID] [--phase ID] [--work-id ID] [--task TEXT] [--evidence] [--dry-run|--render-only] [--out FILE]
  singularity-flow wm show-prompt [--phase ID] [--work-id ID] [--skill ID] [--task TEXT] [--evidence]
  singularity-flow wm brief [--phase ID] [--work-id ID] [--json] [--polish [--refresh]]   The repository brief a phase receives; --polish has a model phrase it
  singularity-flow wm inject [same options]              Compatibility alias for wm compose
  singularity-flow wm rules list|propose [--focus TEXT] [--limit N] [--refresh] [--dry-run] [--json]   Business rules and their drafted or confirmed meaning
  singularity-flow wm rules confirm RULE-ID [--condition TEXT] [--outcome TEXT] [--intent TEXT] [--json]   A person confirms what a rule means
  singularity-flow wm cache status|clear [--json]
  singularity-flow wm ast doctor|status [--json]
  singularity-flow wm ast build [--paths PATH]... [--all] [--max-files N] [--max-bytes N] [--max-facts N] [--max-output-bytes N] [--resume HANDLE] [--json]
  singularity-flow wm ast context [--paths PATH]... [--all] [--max-files N] [--max-bytes N] [--max-facts N] [--max-output-bytes N] [--cursor CURSOR] [--json]
  singularity-flow wm ast query --predicate symbol|symbol-id|import|references|hierarchy|module|language|path --value VALUE [--paths PATH]... [--max-facts N] [--max-output-bytes N] [--cursor CURSOR] [--json]
  singularity-flow wm ast gate [--paths PATH]... [--all] [--json]
  singularity-flow wm ast evidence reproduce --receipt PATH [--json]  # replay is a compatibility alias
  singularity-flow wm ast warm --semantic --provider PACK --profile PROFILE [--project KIND:ROOT] [--toolchain PATH] [--project-tool PATH] --dry-run|--confirm PHRASE [--json]
  singularity-flow wm ast pack list|status|doctor [PACK] [--json]
  singularity-flow wm ast pack install <LOCAL-MANIFEST> --dry-run|--confirm PHRASE [--json]
  singularity-flow wm ast pack remove <PACK> --dry-run|--confirm PHRASE [--json]
  singularity-flow wm ast cache status|prune|clear [--dry-run] [--confirm "PRUNE AST CACHE"|"CLEAR AST CACHE"] [--json]
  singularity-flow wm ast preference show|set auto|off [--json]
  singularity-flow jira status [--json]
  singularity-flow jira doctor [--json]
  singularity-flow jira assigned [--project KEY] [--type Story] [--limit 25] [--json]
  singularity-flow jira list [same options]             Compatibility alias for jira assigned
  singularity-flow jira projects [--query TEXT]
  singularity-flow jira epics --project KEY
  singularity-flow jira children EPIC-KEY
  singularity-flow jira permissions --project KEY
  singularity-flow jira boards [--project KEY] [--limit 100] [--json]
  singularity-flow jira board <BOARD-ID> [--state active,future] [--type Story] [--limit 500] [--json]
  singularity-flow jira pull <WORK-ID> [--json]
  singularity-flow jira show <WORK-ID> [--json]      Alias for jira pull
  singularity-flow jira fields [--query TEXT] [--json]
  singularity-flow jira transitions <WORK-ID> [--json]
  singularity-flow jira transition <WORK-ID> --to STATUS --confirm <WORK-ID> [--expected-updated-at ISO] [--json]
  singularity-flow jira assign <WORK-ID> --to me|unassigned|ACCOUNT-ID --confirm <WORK-ID> [--json]
  singularity-flow jira priority <WORK-ID> --to NAME|ID --confirm <WORK-ID> [--json]
  singularity-flow jira sprint <WORK-ID> --to SPRINT-ID --confirm <WORK-ID> [--json]
  singularity-flow jira comment <WORK-ID> --text TEXT --confirm <WORK-ID> [--json]
  singularity-flow plugin install                     Installs plugin plus direct /sf-* personal skills
  singularity-flow pause [on|off|status] [--json]       Pause SFlow Copilot guidance; preserve Story state
  singularity-flow plugin uninstall | list | verify [--json] | path
  singularity-flow snapshot [WORK-ID] [--include SLICE] [--if-revision HASH] [--timings] [--git-shadow] --json
  singularity-flow configuration validate [--json]       Lists every workflow.yml problem with its line and fix
  singularity-flow configuration drafts [--json]         Agent, skill and instruction changes saved as drafts (no Story uses them yet), and any approved elsewhere or in conflict
  singularity-flow configuration propose [--message TEXT] [--json]  Propose every draft as one review; drafts already approved are settled, not proposed
  singularity-flow configuration discard <NUMBER> --listing LISTING | <DRAFT-ID> | --all [--json]
                                                        drop drafts: a number from the list with that list's --listing, or a draft ID
  singularity-flow configuration approve [<PROPOSAL>] [--yes] [--json]  Show what a proposal changes, confirm, and activate exactly that revision
  singularity-flow configuration recreate-sync [--apply --confirm sha256:<PREVIEW>] [--json]  Preview lists every proposal it replays (teammates' unreviewed ones too) and its confirmation; apply replays only that reviewed list and refuses if it changed
  singularity-flow configuration cleanup-history [--keep-recent 10] [--apply --confirm <HASH>] [--json]  Preview exact snapshot branches; archive commits as tags before retiring old branch refs (up to 100 per confirmed batch); also runs after each publication unless ledger.configurationHistory.autoClear is false
  singularity-flow configuration transactions [--json]     Inspect retained configuration operations; the journal grants no authority
  singularity-flow configuration reconcile <CFT-ID> [--json]  Reconcile a committed operation and finish reference sync; never retry a push blindly
  singularity-flow configuration explain [--pointer JSON-POINTER] [--json]
  singularity-flow configuration save <PATH> [--propose]    Reads replacement content from stdin; never an agent file (agents create|edit)
  singularity-flow configuration add-current-identity [--target *|story:*|initiative:*|SCOPE:GROUP] [--self-approval on|off] [--auto-enroll on|off] [--automatic] [--json]
  singularity-flow state planes [WORK-ID] [--json]
  singularity-flow state reconcile [WORK-ID] --check|--repair-projections [--json]
  singularity-flow initiative profiles [--json]
  singularity-flow initiative choices begin start|approve <INIT-ID> [SUBJECT] [--json]
  singularity-flow initiative start <INIT-ID> [--jira] [--title TEXT] [--description TEXT]
    [--profile ID] [--agent ID] [--start-phase ID] [--selection-receipt TOKEN]
    (--start-phase enters at a later stage; the phases before it are recorded as skipped)
  singularity-flow initiative resume <INIT-ID> [--fetch]
  singularity-flow initiative restart <INIT-ID> [--reason TEXT] [--confirm INIT-ID]
  singularity-flow knowledge [list] [--type TYPE] [--status open|resolved] [--tag TAG] [--query TEXT] [--json]
  singularity-flow knowledge show <K-ID> [--json]
  singularity-flow knowledge record <insight|decision|gotcha|constraint|uncertainty> --title TEXT [--detail TEXT]
  singularity-flow knowledge import <REPOSITORY-RELATIVE-MANIFEST.json|yaml|yml> [--dry-run] [--json]
  singularity-flow knowledge harvest [--initiative INIT-ID] [--phase PHASE] [--dry-run] [--json]
  singularity-flow knowledge resolve <K-ID> --resolution TEXT [--json]

  singularity-flow initiative status [INIT-ID] [--json]
  singularity-flow initiative next [INIT-ID] [--json]
  singularity-flow initiative outputs [PHASE] [--include a,b,c] [--reason TEXT]
  singularity-flow initiative applicability [--json]
  singularity-flow initiative applicability set <POLICY> <yes|no> [--reason TEXT] [--json]
  singularity-flow initiative phase [publish] [PHASE]
  singularity-flow initiative phase draft-check [PHASE] [--initiative INIT-ID] [--json]
  singularity-flow initiative context [PHASE] [--agent ID] [--dry-run] [--json]
  singularity-flow initiative documents [PHASE] [--json]
  singularity-flow initiative checklist [PHASE] [--json]
  singularity-flow initiative evidence add <CHECK-ID> --assurance LEVEL [--path FILE | --url URL]
  singularity-flow initiative evidence list [CHECK-ID] [--json]
  singularity-flow initiative verify [PHASE] [--json]
  singularity-flow initiative approve <OUTPUT|CHECK|phase> [--selection-receipt TOKEN]
  singularity-flow initiative reject <OUTPUT|CHECK|phase> --reason TEXT
  singularity-flow initiative breakdown [--initiative INIT-ID] [--probe] [--json]
  singularity-flow initiative materialize [--initiative INIT-ID] [--dry-run] [--confirm INIT-ID]
  singularity-flow initiative jira-adopt EPIC-KEY [--repository JIRA-KEY=REPO] [--dry-run]
  singularity-flow initiative jira-plan
  singularity-flow initiative jira-apply --plan SHA256 [--confirm INIT-ID]
  singularity-flow initiative sync [INIT-ID]
  singularity-flow initiative sync [INIT-ID] --set-aside [--confirm COMMIT] [--json]
  singularity-flow initiative recover [INIT-ID] [--json]
  singularity-flow initiative contracts [add] [--id ID --version VERSION --format FORMAT --path FILE]
  singularity-flow initiative report [INIT-ID] [--format md|json] [--out FILE]
  singularity-flow initiative gate [INIT-ID] [--terminal] [--json]
  singularity-flow epic start <EPIC-KEY> [--selection-receipt TOKEN]
  singularity-flow epic start --local --title "Epic title" --description TEXT --goal TEXT [--agent ID]
  singularity-flow epic sources [list|add|note|answer|verify|materialize|detach] [--epic EPIC-KEY]
    [--provider ID] [--file PATH | --url URL] [--label TEXT] [--mime TYPE]
    [--text TEXT | --text-file FILE] [--active|--all]
    detach <SOURCE-ID> --epic EPIC-KEY --reason TEXT [--yes]
  singularity-flow epic requirements prepare|status|publish|approve
  singularity-flow epic planning prepare|status|validate|publish|approve
    Approving the Story plan is an explicit business review: it needs the exact
    "<phase>:<subject>" confirmation, and --acknowledge-self-approval when you
    generated any of its outputs yourself.
  singularity-flow epic stories list|show|add|update|split|adopt|validate|metadata|tasks
    add --title TEXT --repository ID [--description TEXT] [--specification TEXT]
      [--requirements REQ-nnn,...] [--acceptance-criteria AC-nnn,...] [--depends-on PLAN-ID,...]
      [--workflow ID] [--epic-plan-id ID]                (the only way in without a tracker)
    update <PLAN-ID> [--metadata KEY=VALUE]... [--tasks-file FILE]
    split <PLAN-ID> [--title TEXT] [--repository ID] [--metadata KEY=VALUE]...
    adopt <JIRA-KEY> --repository ID --requirements REQ-nnn --acceptance-criteria AC-nnn
    metadata <PLAN-ID> list|set|remove|clear [KEY] [VALUE]
    tasks <PLAN-ID> list|add|update|remove [TASK-ID] [--title TEXT] [--description TEXT]
  singularity-flow epic jira preview [--epic EPIC-KEY] [--artifact PHASE/OUTPUT]... [--artifact-to epic|stories|both]
  singularity-flow epic jira apply --epic EPIC-KEY --plan SHA256 --confirm EPIC-KEY
  singularity-flow epic jira apply --epic EPIC-KEY --plan current     (your own terminal: shows the reviewed plan, asks for the Epic ID)
  singularity-flow epic create-stories [--epic EPIC-KEY] [--plan SHA256] [--confirm EPIC-KEY]  Deprecated mapping target
    [--artifact PHASE/OUTPUT]... [--artifact-to epic|stories|both]
  singularity-flow epic status|sync|next|report|resume|journey [EPIC-KEY]
  singularity-flow epic merge-plan [--epic EPIC-KEY]
  singularity-flow epic pr [--epic EPIC-KEY] [--create] [--yes] [--json]
  singularity-flow epic impact [--epic EPIC-KEY] [--json] [--markdown]
  singularity-flow epic complete [EPIC-KEY] [--dry-run] [--json] [--confirm EPIC-KEY]
  singularity-flow epic review [STORY-KEY] [--epic EPIC-KEY] [--packet SHA256]
  singularity-flow epic review-choice begin approve|reject <STORY-KEY> [--epic EPIC-KEY] [--packet SHA256]
  singularity-flow epic review-choice answer <TOKEN> <CHOICE> <ID>
  singularity-flow epic review-choice status <TOKEN>
  singularity-flow epic review approve|reject <STORY-KEY> --packet SHA256
    [--selection-receipt TOKEN] [--to PHASE] [--reason TEXT]
  singularity-flow epic checks <STORY-KEY> [--epic EPIC-KEY] [--packet SHA256]
  singularity-flow epic drift observe|adopt|restore-plan [--epic EPIC-KEY]
  singularity-flow story branch create <BRANCH> --parent <STORY-KEY>
  singularity-flow story branch attach|status|promote --parent <STORY-KEY> [--mode pr|direct]
  singularity-flow story enhance-description --draft-stdin [--json]
  singularity-flow story start <STORY-KEY> --from-branch BRANCH [--target-url AUTHORIZED-URL] [--selection-receipt TOKEN] [--fetch]
    [--reference-repository ID=URL --reference-branch ID=BRANCH]...
  singularity-flow story references inspect --reference-repository ID=URL --reference-branch ID=BRANCH [--prefetch] [--json]
  singularity-flow story references [list|verify|materialize] [--work-id WORK-ID] [--json]
  singularity-flow story inbox [--assigned-to-me] [--project KEY] [--json]
  singularity-flow story fetch <STORY-KEY> [--directory PATH] [--target-url AUTHORIZED-URL] [--json]
  singularity-flow story interval status|checkpoint|reconcile|escalate [--parent STORY-KEY]
    checkpoint [--name TEXT] [--note TEXT]       (local only; never commits unfinished source)
    reconcile [--json]                          (deterministic local baseline/spec comparison)
    escalate [--to WORK-TYPE] [--json]          (non-destructive plan; immutable work type is preserved)
  singularity-flow story submit
  singularity-flow story converge [--work-id ID] [--assisted [--model NAME] [--refresh]] [--json]
  singularity-flow story adjudicate <ITEM-ID> [--item ITEM-ID]...
    --disposition rework|update-intent|accepted-deviation|dismissed|deferred [--reason TEXT]
    [--classification missing|partial|contradicts|unplanned] [--clause ID]... [--json]
  singularity-flow story adjudicate [--work-id ID]  (your own terminal: the whole table, one reason for all or each its own)
  singularity-flow story adjudicate --answers FILE --expect DIGEST [--work-id ID]  (several items at once, each with its own answer)
  singularity-flow story adjudications [--work-id ID] [--json]  (what changed, what the plan says, what is decided)
  singularity-flow story intent-amendment status [--work-id ID] [--json]
  singularity-flow story intent-amendment draft [--clause ID]... [--adopt CLAUSE-ID]... [--out FILE] [--work-id ID] [--json]
  singularity-flow story intent-amendment preview [AMD-ID | --file AMENDED-SPEC.md] [--work-id ID] [--json]
    What approving it does, by the computation approval applies: each later step reset, kept (rule E8) or asked
    whether it still holds, and why; the stale clauses and the earlier changes it repeats. Records nothing.
  singularity-flow story intent-amendment propose --file AMENDED-SPEC.md --reason TEXT [--work-id ID]
    [--authored human|governed-agent|external-tool] [--channel CHANNEL]
    [--external-ai none|assisted] [--change-origin ORIGIN...]
    [--source-phase CURRENT-PHASE] [--clause ID]... (optional exact list; otherwise computed)
    [--add-row CLAUSE=PATH[,PATH] [--test TEST | --test CLAUSE=TEST]...] [--remove-row CLAUSE]... [--keep-row CLAUSE]...
    Available in every workflow after scope approval; no convergence finding or rework loop required.
    A separate approved plan the amendment would leave without a row for a clause it adds, with one for a clause
    it removes, or with one for a clause it revises, gets that row from the amendment itself (--add-row,
    --remove-row, and --keep-row or a decision plan row update): the plan's approvers sign it by deciding the
    amendment, and the plan keeps its approval.
  singularity-flow story intent-amendment decide <AMD-ID> --decision approve|reject --confirm <AMD-ID>
  singularity-flow story intent-amendment acknowledge [AMD-ID]
  singularity-flow story skill-version status [--work-id ID] [--json]
  singularity-flow story target-origin [WORK-ID] --url AUTHORIZED-URL [--reason TEXT --confirm PLAN-DIGEST] [--json]
    Pins the authorized browser target to a Story started without --target-url. The preview names the
    plan digest; a person who approves a step that smoke-checks it confirms it. A pinned origin is never replaced.
  singularity-flow story test-policy show [--work-id ID] [--json]
  singularity-flow story test-policy scope [WORK-ID] [--to all-configured|changed-and-affected|new-and-changed] [--reason TEXT] [--json]
    Shows or changes which tests this Story's gates run, at any step while it is open. Moving to fewer tests needs --reason;
    new-and-changed runs only the test files the Story added, changed or planned. Recorded runs stay as they are.
  singularity-flow story test-policy risks [--work-id ID] [--phase PHASE] [--obligation DOCUMENT-ID] [--operation publish|submit|approve|downstream|replay] [--json]
  singularity-flow story test-policy accept-risk --issue ISSUE-ID --reason TEXT --follow-up-owner ID --remediation TEXT
    [--work-id ID] [--phase PHASE] [--repository ID] [--obligation DOCUMENT-ID] [--operation publish|submit|approve|downstream|replay] [--expires UTC-ISO]
    [--apply --confirm PLAN-DIGEST] [--json]
  singularity-flow story test-policy revoke-risk --record-sha256 RECORD-DIGEST --reason TEXT [--work-id ID]
    [--apply --confirm PLAN-DIGEST] [--json]
  singularity-flow story test-policy attest-risk [--record-sha256 RECORD-DIGEST] [--work-id ID]
    [--apply --confirm PLAN-DIGEST] [--json]
    (preview first; pinned delegated human review required; no integrity bypass or automatic test pass)
  singularity-flow story test-policy plan [--work-id ID] [--phase PHASE] [--json]
  singularity-flow story test-policy confirm [--work-id ID] --phase PHASE --confirm PLAN-DIGEST
  singularity-flow story test-policy repair [--work-id ID] [--repository ID] [--plan] [--json]
  singularity-flow story test-policy repair [--work-id ID] [--repository ID] --run --confirm PLAN-DIGEST [--json]
  singularity-flow story test-policy baseline WORK-ID --phase PHASE --repository ID --base COMMIT [--work-type TYPE] [--isolated-worktree] [--json]
  singularity-flow story test-policy baseline WORK-ID --phase PHASE --repository ID --base COMMIT [--work-type TYPE] [--isolated-worktree] --run --confirm PLAN-DIGEST [--json]
    (pre-Story native execution only; captures exact baseline, never accepts its failures)
  singularity-flow story test-policy baseline-admission WORK-ID --phase PHASE --repository ID --record-sha256 RECORD-DIGEST
    --reason TEXT --follow-up-owner ID --remediation TEXT --expires UTC-ISO [--apply --confirm PLAN-DIGEST] [--json]
    (re-review retained baseline admission after expiry/revocation; no feature execution or automatic acceptance)
  singularity-flow story approvers refresh [WORK-ID] --reason TEXT [--confirm PLAN-DIGEST] [--json]
  singularity-flow story test-policy amend --reason TEXT [--work-id ID] [--phase PHASE] [--json]
  singularity-flow story test-policy amend --reason TEXT [--work-id ID] [--phase PHASE] --apply --confirm PLAN-DIGEST [--json]
    (current active code phase; preserves published generations; fresh epoch validation; live authorized terminal review; no tests waived)
  singularity-flow story test-policy attest [WORK-ID] [--json]
  singularity-flow story test-policy attest [WORK-ID] --apply --confirm REVIEW-SHA256 [--json]
    (restore review origin in a new checkout; exact retained reviewer; no Story or Git records change)
  singularity-flow story skill-version preview <SKILL-ID> --reason TEXT [--work-id ID] [--json]
  singularity-flow story skill-version propose <SKILL-ID> --reason TEXT [--work-id ID]
    [--confirm sha256:PREVIEW-DIGEST] [--json]   (without --confirm: read-only preview)
  singularity-flow story skill-version decide <PROPOSAL-ID> --decision approve|reject
    --reason TEXT [--work-id ID] [--confirm sha256:PREVIEW-DIGEST] [--json]
  singularity-flow constitution check|show [--work-type ID] [--path FILE] [--json]
  singularity-flow constitution generate [--work-type ID] [--path FILE] [--dry-run]
  singularity-flow constitution except <ARTICLE-ID> --reason TEXT [--scope TEXT] [--expires ISO] [--work-id ID]
  singularity-flow story rework [--work-id ID] [--reason TEXT] [--confirm]
  singularity-flow story rework roll-forward [--work-id ID] [--change-request CR-ID]
    [--json] [--confirm sha256:...]              (preview first; backup and restore without rewriting history)
  singularity-flow story advance [--work-id ID] [--confirm sha256:<REVIEW-DIGEST>]
  singularity-flow story checks [--parent STORY-KEY] [--packet SHA256]
  singularity-flow story finalize [--json]
  singularity-flow finalize [--json]
  singularity-flow workspace create --jira KEY --base DIRECTORY --lead REPOSITORY
    --repository ID=URL [--repository ID=URL] [--confirm KEY] [--clone] [--allow-synced-folder]
  singularity-flow workspace create --local --id ID [--name TEXT]
    --organisation LEAD-URL --capability ID [--capability ID] [--lead-capability ID]
    [--base DIRECTORY] [--confirm ID] [--clone] [--dry-run] [--allow-synced-folder]
  singularity-flow workspace create --local --id ID --lead REPOSITORY --repository ID=URL
    [--base DIRECTORY] [--confirm ID] [--clone] [--allow-synced-folder]   (no capability map yet)
  singularity-flow workspace prepare <REMOTE-OR-MANIFEST> --id ID [--name TEXT] [--base DIRECTORY]
    [--branch BRANCH] [--repository-id ID] [--clone-mode full|blobless|blobless-sparse]
    [--sparse-cone PATH]... [--clone-fallback refuse|full] [--clone] [--initialize] [--state-branch NAME]
    [--allow-synced-folder] [--json]
  singularity-flow workspace prepare <LEAD-URL> --id ID --capability ID...
    [--lead-capability ID] [--base DIRECTORY] [--clone] [--initialize] [--allow-synced-folder] [--json]
    (default: register approved repository paths without cloning application code;
     --clone checks out now; --initialize implies a checkout and initializes state)
  singularity-flow workspace bootstrap status [BOOTSTRAP-ID] [--json]
  singularity-flow workspace bootstrap resume <BOOTSTRAP-ID> --confirm WORKSPACE-ID [--json]
  singularity-flow workspace bootstrap retry <BOOTSTRAP-ID> --confirm WORKSPACE-ID --reason TEXT [--json]
  singularity-flow workspace bootstrap abandon <BOOTSTRAP-ID> --reason TEXT [--json]
  singularity-flow workspace doctor [--network] [--repository URL]... [--json]
  singularity-flow push status [INTENT-ID] [--all] [--json]
  singularity-flow push retry <INTENT-ID> [--json]
  singularity-flow integrations list [--work-id ID] [--json]
  singularity-flow integrations status [--work-id ID] [--all] [--json]
  singularity-flow integrations retry <DELIVERY-KEY...>|--all [--json]
  singularity-flow integrations record [--dry-run] [--json]
  singularity-flow integrations deliver --commit <SHA> [--trusted-ref REF] [--record] [--json]
  singularity-flow integrations test <TARGET> [--trigger submitted|approved|rejected] [--send event|summary]
    [--phase ID] [--send-test] [--json]
    (after-step actions: what each step sends to webhooks, logs, Teams, Jira, Git, Confluence or
     OneDrive once it is submitted, approved or rejected; test shows the exact request and sends
     only with --send-test; record commits a receipt for each delivery that went out)
  singularity-flow workspace inspect <URL|DIRECTORY> [--state-branch NAME] [--json]
  singularity-flow repositories providers [--json]
  singularity-flow repositories list [--scope known|provider|all] [--provider github] [--host HOST]
    [--account ACCOUNT-BINDING] [--limit N] [--cursor CURSOR] [--offline] [--audience terminal|native|model]
    [--disclose-provider-results] [--surface cli|copilot|vscode] [--json]
  singularity-flow repositories search <LITERAL-QUERY> [--scope known|provider|all] [--provider github] [--host HOST]
    [--account ACCOUNT-BINDING] [--limit N] [--cursor CURSOR] [--query-stdin] [--audience terminal|native|model]
    [--disclose-provider-results] [--surface cli|copilot|vscode] [--json]
  singularity-flow repositories status [--provider github] [--host HOST] [--check] [--json]
  singularity-flow repositories select <SELECTION-REF> [--action inspect|copy-url] [--json]
  singularity-flow repositories cache status|clear [--json]
  singularity-flow workspace adopt <DIRECTORY> --id ID [--name TEXT] [--base DIRECTORY]
    [--confirm-dirty SHA256] [--confirm ID] [--dry-run] [--allow-synced-folder] [--json]
  singularity-flow workspace capabilities <LEAD-URL> [--json]
  singularity-flow workspace duplicate <DIRECTORY> --id NEW-ID [--name TEXT] [--base DIRECTORY]
    [--clone] [--allow-synced-folder] [--json]
  singularity-flow capability [tree] [--json]
  singularity-flow capability show [PATH] [--verbose] [--git-shadow] [--json]
  singularity-flow why [PATH] [--verbose] [--json]
  singularity-flow capability add <ID> --owns <DIRECTORY|DIRECTORY/**> [--name TEXT] [--team TEXT]... [--parent ID]
  singularity-flow capability protect <PATH> [--capability ID] [--approver GROUP] [--reason TEXT]
  singularity-flow capability depend <TARGET-CAPABILITY>@<REFERENCE> [--from ID] [--contract ID] [--json]
  singularity-flow capability plain-chat <CAPABILITY-ID> [--secrets inherit|refuse|allow]
    [--edits inherit|refuse|record|allow] [--lead URL] [--json]
    (proposes whether a plain Copilot chat may read this capability's files that hold secrets, refused by
     default, and what its change does: refused with the /sf- line to type, recorded (the default) or allowed;
     a child may tighten its parent, never loosen it, and a /sf- turn always refuses secret files)
  singularity-flow capability auto <CAPABILITY-ID> --eligibility inherit|disabled|plan-only|bounded
    [--protected-scope block|allow] [--maximum-touched-paths N] [--maximum-concurrent-flights N]
  singularity-flow capability adopt-managed --preview [--lead URL]
  singularity-flow capability adopt-managed --confirm sha256:<PLAN> [--lead URL]
  singularity-flow capability of <REPOSITORY-ID> [--json]
  singularity-flow capability add|set <CAPABILITY-ID> [--name TEXT] [--kind collection|delivery] [--parent ID]
    [--repository ID] [--metadata KEY=VALUE]... [--jira-project KEY] [--jira-board TEXT]
    [--app-id ID] [--teams A,B] [--owns A,B] [--application-file FILE] [--json]
  singularity-flow capability remove <CAPABILITY-ID> [--reparent-children-to ID] [--json]
    (add, set, and remove author only the checkout; use map or remote edit to publish)
  singularity-flow capability map <CAPABILITY-ID> [--lead URL] [--repository URL]... [--name TEXT]
    [--kind collection|delivery] [--type tech|business] [--parent ID] [--lead-repository URL]
    [--source-roots DIR,...] [--shared-roots DIR,...]
    [--clone-mode full|blobless|blobless-sparse] [--sparse-cone DIR,...] [--clone-fallback refuse|full]
    [--metadata KEY=VALUE]... [--doc KEY=VALUE]... [--resource KEY=VALUE]...
    [--jira-project KEY] [--app-id ID] [--teams A,B] [--json]
    (--repository is repeatable and required for delivery; omit it for collection. --lead-repository
     says which delivery repository holds lifecycle state when there are several. Remote mapping
     pushes a review branch against sflow/config and never writes an application branch.)
  singularity-flow capability map-team <TEAM-ID> --lead <LEAD-URL> --name <TEAM-NAME>
    [--jira-project KEY] [--app-id ID] [--member <CHILD-ID>=<GIT-URL>]...
    [--member-name <CHILD-ID>=<FRIENDLY-NAME>]... [--link <EXISTING-CAPABILITY-ID>]... [--json]
  singularity-flow capability map-team --request <JSON-FILE> [--json]
    (creates or extends one team collection with at most 20 combined members and links. New members
     use whole-repository scope and blobless clones with no full-clone fallback. The command creates
     one atomic review proposal and never implicitly reparents an existing capability. Native hosts
     use the bounded, closed request file so valid team data never exceeds Windows process argv;
     the individual flags remain available for small manual invocations.)
  singularity-flow capability onboard <REPOSITORY-URL> --dry-run [--refresh] [--state-branch NAME]
    [--migrate | --recreate | --reset-local] [--json]
  singularity-flow capability onboard <REPOSITORY-URL> --confirm-plan sha256:<PLAN>
    [--state-branch NAME] [--migrate | --recreate | --reset-local] [--json]
    (one repository-setup front door: preview exact effects first, then apply only the unchanged
     ref-bound plan; migrate reconciles packaged seeds only in valid workflow-v2 configuration;
     offline reset-local clears only the capability lead registry and organisation cache, not
     workspace/session registrations or FOS pins)
  singularity-flow capability setup-proposals [--lead URL] [--all] [--json]
  singularity-flow capability setup-proposal <SETUP-BRANCH> [--lead URL] [--json]
  singularity-flow capability setup-activate <SETUP-BRANCH> [--lead URL]
    --confirm <FULL-COMMIT> [--acknowledge-unprotected] [--json]
    (review and activate an exact repository setup proposal; the source plan and target ref are
     rechecked, and direct push requires explicit acknowledgement. Protected refs use external review.)
  singularity-flow capability inspect-repository <GIT-URL> [--lead URL]... [--search-known]
    [--include-proposals] [--refresh] [--state-branch NAME] [--json]
    (read-only portable state-link/self-hosted lookup by default; registered-map search and proposal
     enumeration are explicit because they can add remote Git requests)
  singularity-flow capability projects <GIT-URL> [--branch NAME] [--lead URL] [--json]
  singularity-flow capability projects --path <CHECKOUT> [--lead URL] [--json]
    (read-only: the projects a monorepo's build tools declare, each with the capability map command
     that scopes it: source roots, shared roots it depends on, and its sparse clone; maps nothing)
  singularity-flow capability test-setup [--source-root <MODULE>]... [--json]
                                                           read-only test runner suggestions; Copilot /sf-test-setup
  singularity-flow capability test-setup [--step <STEP> [--workflow <WORKFLOW>]] (--use <SUGGESTION-ID>... [--source-root <MODULE>]...
    | --id <ID> --argv '<JSON ARRAY>' --working-directory <DIR> --affected-root <DIR>... --adapter <ADAPTER> --report <PATH>
      [--level unit|component|integration|e2e|other] [--env NAME=VALUE]... [--environment <ID>]) [--confirm sha256:PLAN] [--json]
    (test commands are the repository's: tests: in workflow.yml, used by every step that runs tests; a step names
     testLevels or testIds to run fewer, and --step saves a command for one step only. The person who chose them
     activates the proposal: the line the result prints, or Workflow Studio → Changes → Review and activate)
  singularity-flow capability edit <CAPABILITY-ID> [--lead URL] [--name TEXT] [--kind collection|delivery]
    [--mode add|set|remove]
    [--reparent-children-to ID]
    [--type tech|business] [--parent ID] [--repositories A,B] [--lead-repository ID]
    [--source-roots DIR,...] [--shared-roots DIR,...]
    [--metadata KEY=VALUE]... [--doc KEY=VALUE]... [--resource KEY=VALUE]...
    [--auto-eligibility inherit|disabled|plan-only|bounded]
    [--auto-protected-scope block|allow]
    [--auto-maximum-touched-paths N] [--auto-maximum-concurrent-flights N]
    [--plain-chat-secrets inherit|refuse|allow] [--plain-chat-edits inherit|refuse|record|allow]
    [--application-file FILE]   (the whole application block, e.g. app suggest's applicationDraft)
    [--json]   (no checkout needed)
  Capability parents are optional. Omit --parent to create a top-level capability; clear it in the
  VS Code capability designer to move an existing capability back to the top level.
  Removing a capability with children requires --reparent-children-to. Pass an empty value to move
  those direct children to the top level; older reviewed map revisions remain available in Git.
  singularity-flow capability publish [--lead URL] [--json]
    (after a capability review branch is merged, refresh its orphan state projection)
  singularity-flow capability fsck [--lead URL | --repository DELIVERY-URL]
    [--search-known] [--portable-discovery] [--json]
    (read-only verification of registered workspace bindings, approved configuration,
     state projection, proposal refs, and optional cross-laptop authority links; returns exact
     remediation commands)
  singularity-flow capability reconcile <DELIVERY-URL> --canonical-lead <URL>
    [--confirm-plan PLAN-ID] [--json]
    (without confirmation, previews exact observed authorities and the one routing-link write;
     confirmation never deletes or rewrites an independent capability map)
  singularity-flow capability reconcile <DELIVERY-URL> --remove-stale --lead <URL>
    [--state-branch NAME] [--confirm-plan PLAN-ID] [--json]
    (after the current approved lead proves it no longer claims the exact delivery repository,
     previews and then exact-CAS deletes only its obsolete state-branch authority-link file)
  singularity-flow capability proposals [--lead URL] [--all] [--json]
  singularity-flow capability map <CAPABILITY-ID> [--lead URL]
    [--supersede-branch REVIEW-BRANCH --supersede-commit FULL-COMMIT] [--json]
    (replace only the exact prior pending mapping of this same capability in one atomic push;
     an unrelated proposal is never cancelled by ID or repository guess)
  singularity-flow capability proposal <REVIEW-BRANCH> [--lead URL] [--json]
  singularity-flow capability rebase-proposal <REVIEW-BRANCH> [--lead URL] [--json]
    (preview a typed additive map proposal against the exact current authority; no write)
  singularity-flow capability rebase-proposal <REVIEW-BRANCH> [--lead URL]
    --confirm <FULL-SOURCE-COMMIT> --confirm-plan <PLAN-ID> [--json]
    (create a new review branch from the current authority; retain the original proposal,
     never activate or rewrite approved configuration automatically)
  singularity-flow capability discard-proposal <REVIEW-BRANCH> [--lead URL]
    --confirm <FULL-COMMIT> --reason TEXT [--json]
    (deletes only an invalid, unrelated-history, or proven unmergeable proposal at the exact
     current remote commit; requires a reason and never changes approved configuration)
  singularity-flow capability cancel-proposal <REVIEW-BRANCH> [--lead URL]
    --confirm <FULL-COMMIT> --reason TEXT [--json]
    (explicitly cancels one Git-proven unmerged proposal at its exact current remote commit;
     never changes approved configuration or another proposal)
  singularity-flow capability repair-proposal <REVIEW-BRANCH> [--lead URL]
    --confirm <FULL-COMMIT> [--json]
    (advances only the retained review branch with byte-exact recognized packaged-asset upgrades;
     the repaired commit must be reviewed again and approved/application branches are unchanged)
  singularity-flow capability activate <REVIEW-BRANCH> [--lead URL] --confirm <FULL-COMMIT>
    [--acknowledge-unprotected] [--json]
    (review and normally merge one exact proposal into sflow/config, then refresh its projection;
     protection is unknown until the real exact-CAS update; a direct attempt requires explicit acknowledgement;
     application main is never written)
    (a capability that ships has its lead's model; one that groups others composes theirs)
  singularity-flow capability organisation [LEAD-URL] [--readiness] [--refresh] [--json]
    (--readiness asks each remote whether its state branch and world model exist;
     --refresh bypasses the commit-validated organisation cache)
  singularity-flow capability leads [--json]
  singularity-flow workspace update <DIRECTORY> [--name TEXT] [--lead ID]
    [--repository ID=URL] [--confirm KEY] [--dry-run] [--json]
    (capability changes use attach-capability or detach-capability so bindings and clones stay consistent)
  singularity-flow workspace attach-capability <DIRECTORY> <CAPABILITY-ID>
    [--dry-run | --confirm-plan PLAN-ID] [--json]
    (rebuilds repository bindings from the approved capability map; reuses an existing checkout
     or clones only a missing required repository)
  singularity-flow workspace detach-capability <DIRECTORY> <CAPABILITY-ID> [--drop-local]
    [--dry-run | --confirm-plan PLAN-ID] [--json]
    (detach keeps checkouts; --drop-local removes only workspace-owned, clean, fully published,
     unshared non-lead checkouts after an exact safety preview)
  singularity-flow workspace rename <DIRECTORY> --name TEXT --confirm KEY [--json]
  singularity-flow workspace archive-status <DIRECTORY> [--fetch|--no-fetch] [--json]
  singularity-flow workspace archive <DIRECTORY> --confirm KEY [--fetch|--no-fetch] [--json]
  singularity-flow workspace restore <DIRECTORY> [--json]
  singularity-flow workspace list [--table | --json]
  singularity-flow workspace prune [--json]
  singularity-flow workspace current [--git-shadow] [--json]
  singularity-flow workspace stories [WORK-ID] [--rebuild] [--json]
    (every Story checkout on this computer, across workspaces: workspace, repository, checkout,
     branch, phase, status; with a Work ID, where that Story is and the commands that go there)
    (--git-shadow compares the typed Git reader without changing the authoritative result or
     recording repository values; the same evidence-only option is available on status, snapshot,
     and capability show; intended for migration evidence, not ordinary use)
  singularity-flow workspace consolidate [WORKSPACE] [--repository ID] [--confirm-plan PLAN-ID] [--json]
    (one clone per repository: previews moving the Story checkouts a second clone owns onto the
     declared clone; --confirm-plan applies that exact plan; nothing is deleted)
  singularity-flow workspace use [ID|NAME|JIRA|DIRECTORY] [--repository ID] [--story ID] [--json]
  singularity-flow workspace refresh-configuration [WORKSPACE] [--repository ID] [--dry-run]
    [--resolve PATH=local|bundled|merge] [--accept-bundled-conflicts]
    [--confirm-plan PLAN-ID] [--review-only] [--json]
    (--review-only proposes each change on a sflow/config-refresh/* review branch and never pushes
     sflow/config itself)
  singularity-flow workspace reinitialize [WORKSPACE] [--repository ID]
    [--hard-cutover] [--dry-run | --confirm-plan PLAN-ID] [--json]
    (--hard-cutover explicitly retires known existing Stories, preserving their bytes read-only;
     their records no longer block schema compatibility; use new IDs for new Stories)
    (safe, repeatable upgrade path: restores only missing or exact registered framework seeds and
     their framework-owned dependencies; user-created and user-modified workflows, phases,
     artifact sets, templates, prompts, and agents remain repository-owned and unchanged;
     --resolve bundled and --accept-bundled-conflicts are refused here—use the separately reviewed
     refresh-configuration flow for a deliberate ownership transfer; work-item artifacts,
     capability publication, immutable history, and delivery locators remain outside this action)
  singularity-flow workspace migrate-schemas [--json]
    (check every active registered workspace repository; apply registered schema migrations in
     memory and report coverage and blockers; stored records are not rewritten; machine-local,
     workspace-private, content-addressed, and unmapped records are outside this pass)
  singularity-flow workspace copilot [ID|NAME|JIRA|DIRECTORY]
    [--repository ID] [--story ID] [--mode interactive|plan] [--dry-run]
  singularity-flow workspace prompt [--json]
  singularity-flow workspace open <DIRECTORY> [--json]
  singularity-flow workspace status [DIRECTORY] [--level full|summary|readiness] [--json]
  singularity-flow workspace sync <DIRECTORY> [--json]
  singularity-flow workspace repair [DIRECTORY] [--repository ID]... [--level full|summary|readiness] [--json]
  singularity-flow workspace prepare-branch [DIRECTORY] --repository ID --from-branch BRANCH [--json]
    (download only the selected branch into repos/<branch-folder>/<repository-id> with independent
     Git objects; original checkouts, unpublished work and failed downloads are preserved; rerun
     Story readiness from the returned repositoryPath; no Story is started or approved)
  singularity-flow workspace documents <DIRECTORY> [--json]
  singularity-flow workspace documents import <DIRECTORY> <FILE...> [--json]
  singularity-flow workspace impact analyze <DIRECTORY> --description TEXT
    [--title TEXT] [--repository ID]... [--capability ID]... [--document PATH]...
    [--model MODEL] [--dry-run] [--json]
  singularity-flow workspace impact list <DIRECTORY> [--json]
  singularity-flow workspace impact show <DIRECTORY> <ANALYSIS-ID> [--json]
  singularity-flow workspace impact promote <DIRECTORY> <ANALYSIS-ID> [--json]
  singularity-flow workspace forget <DIRECTORY> [--json]

Optional Jira environment:
  JIRA_BASE_URL=https://company.atlassian.net
  JIRA_EMAIL=user@company.com
  JIRA_API_TOKEN=...
  # Data Center alternative:
  JIRA_DEPLOYMENT=data-center
  JIRA_PAT=...
  SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD=customfield_12345
  SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD=customfield_10016
  SINGULARITY_FLOW_JIRA_SPRINT_FIELD=customfield_10020
  SINGULARITY_FLOW_JIRA_EXTRA_FIELDS=customfield_10001,customfield_10002

Typical flow:
  singularity-flow start ENG-142
  singularity-flow prepare intake
  singularity-flow phase publish intake
  singularity-flow submit
  singularity-flow approve --yes
`;
