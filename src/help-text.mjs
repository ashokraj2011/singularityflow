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
  singularity-flow [--no-model] <command> [options]
    --no-model disables every kernel-owned model invocation. Equivalent: SINGULARITY_FLOW_NO_MODEL=1.
  singularity-flow about
  singularity-flow --version | --build
    (--version is a bare semver for scripts; --build adds the commit or validated source digest)
  singularity-flow help [TOPIC|COMMAND] [--json]
  sflow specify [WORK-ID] [--json]
  sflow plan [WORK-ID] [--json]
  sflow implement [WORK-ID] [--json]
  sflow converge [WORK-ID] [--json]
  sflow verify [WORK-ID] [--json]
  singularity-flow explain [TOPIC|ALIAS] [--here] [--section HEADING] [--max-bytes N] [--json]
  singularity-flow show <SFREF-HANDLE|SFDOC-HANDLE> [--section HEADING | --json-pointer POINTER | --range RANGE]
    [--max-bytes N] [--json]
  singularity-flow harness report [--json]
  singularity-flow bootstrap <REPOSITORY-URL> --capability ID [--name TEXT] [--kind collection|delivery]
    [--jira-project KEY] [--teams A,B] [--into DIRECTORY] [--base DIRECTORY]
    [--state-branch NAME | --no-state-branch] [--grounding off|warn|enforce] [--no-push] [--json]
  singularity-flow init [--repair] [--work-id WORK-ID] [--base BRANCH] [--fetch]
  singularity-flow init --check [--json]
  singularity-flow refresh-branch [--remote origin] [--branch CURRENT] [--json]
  singularity-flow factory-reset [--dry-run] [--confirm "RESET REPOSITORY COMMIT"] [--allow-dirty] [--json]
  sflow reset-all [--yes] [--json]
  singularity-flow local-reset [--dry-run | --confirm "RESET LOCAL"] [--json]
  singularity-flow local-reset --forget-only [--dry-run | --confirm "FORGET LOCAL"] [--json]
  sf-local-reset [--dry-run | --confirm "RESET LOCAL"] [--json]
  sf-local-reset --forget-only [--dry-run | --confirm "FORGET LOCAL"] [--json]
  singularity-flow fresh-install [--checkout DIRECTORY] [--yes] [--registry URL] [--cli-only] [--no-copilot-telemetry]
  singularity-flow reinstall --checkout DIRECTORY [--dry-run | --confirm "REINSTALL SINGULARITY FLOW FINGERPRINT"]
    [--registry URL] [--cli-only] [--no-copilot-telemetry] [--json]
  sf-reinstall --checkout DIRECTORY [--dry-run | --confirm "REINSTALL SINGULARITY FLOW FINGERPRINT"]
    [--registry URL] [--cli-only] [--no-copilot-telemetry] [--json]
  singularity-flow stack status [--epic EPIC-ID] [--json]
  singularity-flow stack sync --epic EPIC-ID [--json]
  singularity-flow regression analyze [--base main] [--good REF] [--bad HEAD] [--path PATH]... [--max 20] [--json]
  singularity-flow start <WORK-ID> [--jira | --github URL|owner/repo#number | --story-file FILE] [--title TEXT] [--description TEXT]
    [--acceptance-criteria TEXT] [--document FILE]... [--document-url URL]... --from-branch BRANCH [--fetch] [--allow-dirty]
    [--work-type ID] [--target-url AUTHORIZED-URL] [--agent ID] [--ref CANONICAL-BRANCH] [--capability ID] [--selection-receipt TOKEN]
  singularity-flow choices begin start <WORK-ID> [--json]
  singularity-flow choices begin approve <WORK-ID> [--fetch] [--json]
  singularity-flow choices answer <TOKEN> <CHOICE> <ID> [--json]
  singularity-flow choices status <TOKEN> [--json]
  singularity-flow resume <WORK-ID|BRANCH> [--fetch] [--allow-dirty]
  singularity-flow return <WORK-ID> [--apply --confirm WORK-ID] [--offline] [--json]
  singularity-flow agent [WORK-ID] [--agent ID]
  singularity-flow session status|candidates [--json]
  singularity-flow session workspace <WORKSPACE> [--repository ID] [--story ID] [--json]
  singularity-flow session attach <WORK-ID> [--json]
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
  singularity-flow inbox [--offline] [--json]
  singularity-flow status [WORK-ID] [--json]
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
  singularity-flow context xray [WORK-ID] [--work-id WORK-ID] [--phase PHASE] [--packet CTX-ID] [--json]
  singularity-flow context compile [WORK-ID] [--work-id WORK-ID] [--flight-plan CFP-ID] [--profile PROFILE] [--slice SLICE]... [--max-output-bytes N] [--json]
  singularity-flow context expand <SEALED-HANDLE> [--json]
  singularity-flow context doctor [--json]
  singularity-flow tokens status [WORK-ID] [--work-id WORK-ID] [--phase PHASE] [--json]
  singularity-flow tokens report [WORK-ID] [--work-id WORK-ID] [--phase PHASE] [--packet CTX-ID] [--json]
  singularity-flow tokens compare --study STUDY-ID [--filter DIMENSION=VALUE]... [--json]
  singularity-flow copilot [--mode interactive|plan] [--repository ID] [--story ID]
    [--host cli|vscode-terminal|intellij-terminal] [--dry-run]
  singularity-flow prompt-log on|off|status
  singularity-flow prompt-log list [--agent ID] [--phase ID] [--work-id ID] [--limit N] [--include-prompt] [--json]
  singularity-flow prompt-log view [RECORD-ID|latest] [--json]
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
  singularity-flow logs workspace [--source all|activity|prompt|telemetry|workspace]
      [--repository ID] [--work-id ID] [--phase ID] [--agent ID]
      [--level error|warn|info|debug] [--since ISO-TIMESTAMP] [--limit N] [--json]
  singularity-flow hook <turn-intent|turn-end|agent-start|session-start|agent-guard>
  singularity-flow secrets scan [--staged] [--json]
  singularity-flow secrets protect [--force]
  singularity-flow review [PHASE] [--phase PHASE] [--format md|html|json] [--out FILE]
  singularity-flow workflow list [--json]                  every workflow, Story and Initiative
  singularity-flow workflow create <ID> --phases a,b,c [--label TEXT] [--governs story|initiative]
  singularity-flow workflow edit <ID> [--phases a,b,c] [--label TEXT] [--description TEXT]
  singularity-flow workflow phase add <ID> [--label TEXT] [--views a,b] [--lanes a,b]
    [--agents a,b] [--authorities group-a,group-b] [--minimum N] [--governs story|initiative]
    (a phase runs nowhere until a workflow lists it)
  singularity-flow workflow phase edit <ID> [--label TEXT] [--views a,b] [--agents a,b]
    (--governs is inferred from where the phases already live, and rarely needed)
  singularity-flow workflow phase output add <PHASE> <OUTPUT> --label TEXT --kind markdown --path FILE --template FILE
    [--optional] [--consumes phase/output,...]
  singularity-flow workflow phase output edit <PHASE> <OUTPUT> [--label TEXT] [--kind KIND] [--path FILE]
    [--template FILE] [--optional] [--consumes phase/output,...]
  singularity-flow workflow install <ID> [--dry-run] [--replace]   a packaged workflow
    (add and upgrade are the former names and still work)
  singularity-flow workflow simulate [TYPE] | diff <TYPE>
  singularity-flow assign <PHASE> <ASSIGNEE>
  singularity-flow watch [WORK-ID] [--once] [--fetch] [--interval SECONDS] [--json]
  singularity-flow recover [WORK-ID] [--phase PHASE] [--fetch] [--apply --confirm PLAN-HASH] [--json]
  singularity-flow inputs [PHASE] [--dry-run]
  singularity-flow spec analyze [--phase PHASE] [--work-id ID] [--assisted [--model NAME]] [--json]
  singularity-flow spec index [ARTIFACT] [--phase PHASE] [--work-id ID] [--dry-run] [--json]
  singularity-flow spec claims planned|observed --file JSON_OR_YAML [--phase PHASE] [--json]
  singularity-flow spec coverage [--base REF] [--target REF] [--json]
  singularity-flow spec acceptance [--command ID]... [--phase PHASE] [--dry-run] [--json]
  singularity-flow spec tasks [--phase PHASE] [--work-id ID] [--dry-run] [--json]
  singularity-flow spec trace [CLAUSE-ID] [--format human|json|csv]
  singularity-flow agents list
  singularity-flow agents mappings
  singularity-flow agents lock <PACK> [--update]
  singularity-flow agents sync <PACK>
  singularity-flow agents status [PACK]
  singularity-flow agents refresh-output <RESOURCE-ID> [--replace]
  singularity-flow mcp list|status|doctor [--json]
  singularity-flow mcp scaffold playwright|figma [--local] [--replace-server]
  singularity-flow mcp doctor [--server ID] [--network] [--json]
  singularity-flow mcp warm <SERVER> --network
  singularity-flow mcp attest <SERVER> --confirm <SERVER>
  singularity-flow mcp smoke <SERVER> --url AUTHORIZED-URL [--phase PHASE] [--json]
  singularity-flow mcp record <SERVER> --tool TOOL [--kind tool-call|design-source|visual-artifact]
    [--phase PHASE] [--target-url AUTHORIZED-URL] [--output PATH|--output-url HTTPS-URL] [--file-key KEY] [--file-version VERSION] [--node NODE] [--note TEXT]
  singularity-flow mcp design-sources status [--json]
  singularity-flow mcp design-sources promote <RECORD-ID> --confirm <RECORD-ID> [--reason TEXT]
  singularity-flow visual status [--json]
  singularity-flow visual compare --expected RECORD-OR-PATH --actual RECORD-OR-PATH [--profile ID] [--json]
  singularity-flow wm design-inventory --from-records [--json]
  singularity-flow documents list [WORK-ID] [--active|--all] [--json]
  singularity-flow documents view <DOCUMENT-ID|PATH> [--work-id ID] [--all] [--json]
  singularity-flow documents preview <DOCUMENT-ID|PATH> [--work-id ID] [--json]
  singularity-flow documents upload <FILE-OR-DIRECTORY...> [--url URL] [--label TEXT] [--kind KIND]
  singularity-flow documents detach <DOCUMENT-ID> [--scope file|package] --reason TEXT [--yes]
  singularity-flow prepare [PHASE]
  singularity-flow clarification status [PHASE] [--json]
  singularity-flow clarification record [PHASE] (--question TEXT --answer TEXT | --marker TEXT --answer TEXT | --response-file FILE)
    [--why TEXT] [--status answered|deferred] [--blocking] [--owner TEXT] [--impact TEXT] [--replace]
  singularity-flow phase show [PHASE] [--json]
  singularity-flow phase begin [PHASE] [--json]
    [--adopt-existing|--adopt-current-interval] [--confirm CHANGE-SET-DIGEST]
  singularity-flow phase publish [PHASE]
    [--authored human|governed-agent|deterministic|external-tool]
    [--from FILE] [--channel manual-in-place|manual-import|copilot-host|kernel-model|kernel-generator|external-tool]
    [--external-ai none|assisted] [--usage-json FILE]
  singularity-flow artifact add <PATH...> [--kind KIND] [--phase PHASE]
  singularity-flow artifact scan [--phase PHASE]
  singularity-flow pr describe [WORK-ID] [--format markdown|json] [--clipboard] [--write] [--yes]
  singularity-flow pr [WORK-ID] [--json] [--create] [--yes]
  singularity-flow submit [PHASE] [--phase PHASE] [--skip-checks]
  singularity-flow approve [PHASE] [--work-id WORK-ID] [--fetch] [--phase PHASE] [--yes]
    [--article ID=satisfied|exception|not-applicable]... [--article-reason TEXT]... [--checklist FILE]
  singularity-flow reject [PHASE] [--work-id WORK-ID] [--fetch] --reason TEXT [--to PHASE] [--clause ID]...
  singularity-flow reopen [WORK-ID] [--fetch] --reason TEXT --to PHASE
  singularity-flow cancel [WORK-ID] [--fetch] --reason TEXT --confirm WORK-ID
  singularity-flow sync
  singularity-flow validate [--strict]
  singularity-flow gate [--terminal]
  singularity-flow wm init
  singularity-flow wm light [--branch BRANCH] [--remote REMOTE] [--phase PHASE] [--views LIST] [--task TEXT] [--local]
  singularity-flow wm build [--branch BRANCH] [--remote REMOTE] [--phase PHASE] [--task TEXT] [--focus TEXT] [--depth light|quick|standard|deep] [--parallel|--no-parallel] [--workers N] [--model MODEL]
  singularity-flow wm status [--phase PHASE] [--task TEXT] [--json]
  singularity-flow wm ensure [--phase PHASE] [--task TEXT] [--branch BRANCH] [--remote REMOTE] [--model MODEL]
  singularity-flow wm context <PHASE> [--branch BRANCH] [--remote REMOTE] [--task TEXT] [--concat] [--evidence] [--no-agent]
  singularity-flow wm compose [--agent ID] [--phase ID] [--work-id ID] [--task TEXT] [--evidence] [--dry-run|--render-only] [--out FILE]
  singularity-flow wm show-prompt [--phase ID] [--work-id ID] [--skill ID] [--task TEXT] [--evidence]
  singularity-flow wm inject [same options]              Compatibility alias for wm compose
  singularity-flow wm check [--branch BRANCH] [--remote REMOTE]
  singularity-flow wm cleanup [--force] [--json]
  singularity-flow wm cache status|clear [--json]
  singularity-flow wm ast doctor|status [--json]
  singularity-flow wm ast build [--paths PATH]... [--all] [--max-files N] [--max-bytes N] [--resume HANDLE] [--json]
  singularity-flow wm ast context [--paths PATH]... [--all] [--max-files N] [--max-bytes N] [--max-facts N] [--max-output-bytes N] [--cursor CURSOR] [--json]
  singularity-flow wm recovery list|inspect <ID>|publish <ID> --confirm <ID> [--json]
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
  singularity-flow plugin uninstall | list | path
  singularity-flow snapshot [WORK-ID] [--include SLICE] [--if-revision HASH] [--timings] --json
  singularity-flow configuration validate --json
  singularity-flow configuration save <PATH>    Reads replacement content from stdin
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
  singularity-flow knowledge show <SHA256> [--json]
  singularity-flow knowledge record <decision|learning|uncertainty|result> --title TEXT [--detail TEXT]
  singularity-flow knowledge harvest [--initiative INIT-ID] [--phase PHASE] [--dry-run] [--json]
  singularity-flow knowledge resolve <SHA256> --resolution TEXT [--json]

  singularity-flow initiative status [INIT-ID] [--json]
  singularity-flow initiative next [INIT-ID] [--json]
  singularity-flow initiative outputs [PHASE] [--include a,b,c] [--reason TEXT]
  singularity-flow initiative applicability [--json]
  singularity-flow initiative applicability set <POLICY> <yes|no> [--reason TEXT] [--json]
  singularity-flow initiative phase [publish] [PHASE]
  singularity-flow initiative context [PHASE] [--agent ID] [--dry-run] [--json]
  singularity-flow initiative documents [PHASE] [--json]
  singularity-flow initiative checklist [PHASE] [--json]
  singularity-flow initiative evidence add <CHECK-ID> --assurance LEVEL [--path FILE | --url URL]
  singularity-flow initiative evidence list [CHECK-ID] [--json]
  singularity-flow initiative verify [PHASE] [--json]
  singularity-flow initiative approve <OUTPUT|CHECK|phase> [--selection-receipt TOKEN]
  singularity-flow initiative reject <OUTPUT|CHECK|phase> --reason TEXT
  singularity-flow initiative breakdown [--probe] [--json]
  singularity-flow initiative materialize [--dry-run] [--confirm INIT-ID]
  singularity-flow initiative jira-adopt EPIC-KEY [--repository JIRA-KEY=REPO] [--dry-run]
  singularity-flow initiative jira-plan
  singularity-flow initiative jira-apply --plan SHA256 [--confirm INIT-ID]
  singularity-flow initiative sync
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
      [--epic-plan-id ID]                                (the only way in without a tracker)
    update <PLAN-ID> [--metadata KEY=VALUE]... [--tasks-file FILE]
    split <PLAN-ID> [--title TEXT] [--repository ID] [--metadata KEY=VALUE]...
    adopt <JIRA-KEY> --repository ID --requirements REQ-nnn --acceptance-criteria AC-nnn
    metadata <PLAN-ID> list|set|remove|clear [KEY] [VALUE]
    tasks <PLAN-ID> list|add|update|remove [TASK-ID] [--title TEXT] [--description TEXT]
  singularity-flow epic jira preview|apply [--epic EPIC-KEY] [--plan SHA256]
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
  singularity-flow story start <STORY-KEY> --from-branch BRANCH [--target-url AUTHORIZED-URL] [--selection-receipt TOKEN] [--fetch]
  singularity-flow story inbox [--assigned-to-me] [--project KEY] [--json]
  singularity-flow story fetch <STORY-KEY> [--directory PATH] [--json]
  singularity-flow story interval status|checkpoint|reconcile|escalate [--parent STORY-KEY]
    checkpoint [--name TEXT] [--note TEXT]       (local only; never commits unfinished source)
    reconcile [--json]                          (deterministic local baseline/spec comparison)
    escalate [--to WORK-TYPE] [--json]          (non-destructive plan; immutable work type is preserved)
  singularity-flow story submit
  singularity-flow story converge [--work-id ID] [--assisted [--model NAME]] [--json]
  singularity-flow story adjudicate <ITEM-ID> [--item ITEM-ID]...
    --disposition rework|update-intent|accepted-deviation|dismissed|deferred [--reason TEXT]
    [--classification missing|partial|contradicts|unplanned] [--clause ID]... [--json]
  singularity-flow story intent-amendment status [--work-id ID] [--json]
  singularity-flow story intent-amendment propose --file AMENDED-SPEC.md --reason TEXT [--work-id ID]
  singularity-flow story intent-amendment decide <AMD-ID> --decision approve|reject --confirm <AMD-ID>
  singularity-flow story intent-amendment acknowledge [AMD-ID]
  singularity-flow constitution check|show [--work-type ID] [--path FILE] [--json]
  singularity-flow constitution generate [--work-type ID] [--path FILE] [--dry-run]
  singularity-flow constitution except <ARTICLE-ID> --reason TEXT [--scope TEXT] [--expires ISO] [--work-id ID]
  singularity-flow story rework [--work-id ID] [--reason TEXT] [--confirm]
  singularity-flow story advance [--work-id ID] [--confirm]
  singularity-flow story checks [--parent STORY-KEY] [--packet SHA256]
  singularity-flow story finalize [--json]
  singularity-flow finalize [--json]
  singularity-flow workspace create --jira KEY --base DIRECTORY --lead REPOSITORY
    --repository ID=URL [--repository ID=URL] [--confirm KEY] [--no-clone]
  singularity-flow workspace create --local --id ID [--name TEXT]
    --organisation LEAD-URL --capability ID [--capability ID] [--lead-capability ID]
    [--base DIRECTORY] [--confirm ID] [--no-clone] [--dry-run]
  singularity-flow workspace create --local --id ID --lead REPOSITORY --repository ID=URL
    [--base DIRECTORY] [--confirm ID] [--no-clone]        (no capability map yet)
  singularity-flow workspace prepare <REMOTE-OR-MANIFEST> --id ID [--name TEXT] [--base DIRECTORY]
    [--branch BRANCH] [--repository-id ID] [--clone-mode full|blobless|blobless-sparse]
    [--sparse-cone PATH]... [--clone-fallback refuse|full] [--initialize] [--state-branch NAME] [--json]
  singularity-flow workspace prepare <LEAD-URL> --id ID --capability ID...
    [--lead-capability ID] [--base DIRECTORY] [--initialize] [--json]
  singularity-flow workspace bootstrap status [BOOTSTRAP-ID] [--json]
  singularity-flow workspace bootstrap resume <BOOTSTRAP-ID> --confirm WORKSPACE-ID [--json]
  singularity-flow workspace bootstrap abandon <BOOTSTRAP-ID> --reason TEXT [--json]
  singularity-flow workspace doctor [--network] [--json]
  singularity-flow push status [INTENT-ID] [--all] [--json]
  singularity-flow push retry <INTENT-ID> [--json]
  singularity-flow workspace inspect <URL|DIRECTORY> [--state-branch NAME] [--json]
  singularity-flow workspace adopt <DIRECTORY> --id ID [--name TEXT] [--base DIRECTORY]
    [--confirm-dirty SHA256] [--confirm ID] [--dry-run] [--json]
  singularity-flow workspace capabilities <LEAD-URL> [--json]
  singularity-flow workspace duplicate <DIRECTORY> --id NEW-ID [--name TEXT] [--base DIRECTORY]
    [--no-clone] [--json]
  singularity-flow capability [tree] [--json]
  singularity-flow capability show <CAPABILITY-ID> [--json]
  singularity-flow capability of <REPOSITORY-ID> [--json]
  singularity-flow capability add|set <CAPABILITY-ID> [--name TEXT] [--kind collection|delivery] [--parent ID]
    [--repository ID] [--metadata KEY=VALUE]... [--jira-project KEY] [--jira-board TEXT]
    [--teams A,B] [--owns A,B] [--json]
  singularity-flow capability remove <CAPABILITY-ID> [--reparent-children-to ID] [--json]
    (add, set, and remove author only the checkout; use map or remote edit for governed publication)
  singularity-flow capability map <CAPABILITY-ID> [--lead URL] [--repository URL]... [--name TEXT]
    [--kind collection|delivery] [--type tech|business] [--parent ID] [--lead-repository URL]
    [--source-roots DIR,...] [--shared-roots DIR,...]
    [--clone-mode full|blobless|blobless-sparse] [--sparse-cone DIR,...] [--clone-fallback refuse|full]
    [--metadata KEY=VALUE]... [--doc KEY=VALUE]... [--resource KEY=VALUE]...
    [--jira-project KEY] [--teams A,B] [--json]
    (--repository is repeatable and required for delivery; omit it for collection. --lead-repository
     says which delivery repository holds governed state when there are several. Remote mapping
     pushes a review branch against sflow/config and never writes an application branch.)
  singularity-flow capability edit <CAPABILITY-ID> [--lead URL] [--name TEXT] [--kind collection|delivery]
    [--mode add|set|remove]
    [--reparent-children-to ID]
    [--type tech|business] [--parent ID] [--repositories A,B] [--lead-repository ID]
    [--source-roots DIR,...] [--shared-roots DIR,...]
    [--metadata KEY=VALUE]... [--doc KEY=VALUE]... [--resource KEY=VALUE]...
    [--json]   (no checkout needed)
  Capability parents are optional. Omit --parent to create a top-level capability; clear it in the
  VS Code capability designer to move an existing capability back to the top level.
  Removing a capability with children requires --reparent-children-to. Pass an empty value to move
  those direct children to the top level; older reviewed map revisions remain available in Git.
  singularity-flow capability publish [--lead URL] [--json]
    (after a capability review branch is merged, refresh its orphan state projection)
  singularity-flow capability proposals [--lead URL] [--all] [--json]
  singularity-flow capability proposal <REVIEW-BRANCH> [--lead URL] [--json]
  singularity-flow capability activate <REVIEW-BRANCH> [--lead URL] --confirm <FULL-COMMIT>
    [--acknowledge-unprotected] [--json]
    (review and normally merge one exact proposal into sflow/config, then refresh its projection;
     branch protection is verified by dry-run; an unprotected authority requires explicit acknowledgement;
     application main is never written)
  singularity-flow capability world-model <CAPABILITY-ID> [--lead URL] [--json]
    (a capability that ships has its lead's model; one that groups others composes theirs)
  singularity-flow capability organisation [LEAD-URL] [--readiness] [--refresh] [--json]
    (--readiness asks each remote whether its state branch and world model exist;
     --refresh bypasses the commit-validated organisation cache)
  singularity-flow capability leads [--json]
  singularity-flow workspace update <DIRECTORY> [--name TEXT] [--lead ID] [--capability ID]
    [--repository ID=URL] [--confirm KEY] [--dry-run] [--json]
  singularity-flow workspace rename <DIRECTORY> --name TEXT --confirm KEY [--json]
  singularity-flow workspace archive-status <DIRECTORY> [--fetch|--no-fetch] [--json]
  singularity-flow workspace archive <DIRECTORY> --confirm KEY [--fetch|--no-fetch] [--json]
  singularity-flow workspace restore <DIRECTORY> [--json]
  singularity-flow workspace list [--json]
  singularity-flow workspace prune [--json]
  singularity-flow workspace current [--json]
  singularity-flow workspace use [ID|NAME|JIRA|DIRECTORY] [--repository ID] [--story ID] [--json]
  singularity-flow workspace copilot [ID|NAME|JIRA|DIRECTORY]
    [--repository ID] [--story ID] [--mode interactive|plan] [--dry-run]
  singularity-flow workspace prompt [--json]
  singularity-flow workspace open <DIRECTORY> [--json]
  singularity-flow workspace status <DIRECTORY> [--json]
  singularity-flow workspace sync <DIRECTORY> [--json]
  singularity-flow workspace repair <DIRECTORY> [--json]
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
