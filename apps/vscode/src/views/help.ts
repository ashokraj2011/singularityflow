/** VS Code host for the offline, searchable Singularity Flow Help Center. */
import * as vscode from 'vscode';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import {
  HELP_CENTER_SCRIPT, helpCenterHtml, type HelpAnswerView, type HelpDocument, type HelpMetricsView
} from './help-page.ts';
import { resolveHelp, resolveHelpLink } from '../../../../src/help-service.mjs';
import { helpMetricsStatus, recordHelpMetric } from '../../../../src/help-metrics.mjs';
import { activeRepositoryContext } from '../gateway-runtime-client.ts';
import { onChatModelsChanged } from '../copilot-command.ts';

export class HelpPanel {
  private static current: HelpPanel | null = null;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private document: HelpDocument,
    private requested: string | null,
    private manualRoot: string,
    private answer: HelpAnswerView | null = null,
    private metrics: HelpMetricsView | null = null
  ) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return this.router.route(raw);
    });
    const chatModels = onChatModelsChanged(() => this.render());
    panel.onDidDispose(() => { chatModels.dispose(); HelpPanel.current = null; });
    this.render();
    void this.refreshMetrics();
  }

  static show(
    context: vscode.ExtensionContext,
    document: HelpDocument,
    requested: string | null = null,
    manualRoot = context.extensionPath
  ): HelpPanel {
    if (HelpPanel.current) {
      HelpPanel.current.document = document;
      HelpPanel.current.requested = requested;
      HelpPanel.current.manualRoot = manualRoot;
      HelpPanel.current.answer = null;
      HelpPanel.current.render();
      void HelpPanel.current.refreshMetrics();
      HelpPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return HelpPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.helpCenter', 'Singularity Flow Help', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    HelpPanel.current = new HelpPanel(panel, document, requested, manualRoot);
    return HelpPanel.current;
  }

  /**
   * The one message this panel speaks. `[UXH:REQ-134]` `[UXH:AC-014]`
   *
   * A single-type handler is still an open set: `if (type !== 'open-link') return` drops everything
   * else in silence, so nothing can enumerate what this panel accepts and an unrecognised type is
   * indistinguishable from a handled one. One entry in a closed map says the same thing and can be
   * read from outside.
   *
   * A link carries its served source document, not a guessed package-root path. Only links in
   * the current document/answer are accepted; lexical and real-path containment remain enforced.
   */
  private router = registerMessageRouter('singularityFlow.help', {
    'open-link': (message) => this.openLink(stringField(message, 'source'), stringField(message, 'target')),
    'ask-question': (message) => { void this.askQuestion(
      stringField(message, 'question'), stringField(message, 'origin')
    ); },
    'open-topic': (message) => { void this.openTopic(stringField(message, 'topic')); },
    'copy-command': (message) => { void this.commandCopied(stringField(message, 'topic')); },
    'prefill-action': (message) => { void this.prefillAction(
      stringField(message, 'skill'), stringField(message, 'topic')
    ); }
  });

  private async recordMetric(input: Parameters<typeof recordHelpMetric>[1]): Promise<void> {
    const root = activeRepositoryContext()?.root;
    if (!root) return;
    await recordHelpMetric(root, input).catch(() => {});
    await this.refreshMetrics();
  }

  private async askQuestion(question: string | null, origin: string | null): Promise<void> {
    const query = question?.trim() ?? '';
    if (!query || query.length > 300) return;
    try {
      const result = await resolveHelp(query, { maxBytes: 4000 });
      this.answer = {
        status: result.status === 'resolved' ? 'resolved'
          : result.status === 'ambiguous' ? 'ambiguous'
            : result.status === 'not-found' ? 'not-found' : 'unavailable',
        question: query,
        intent: result.helpIntent,
        matchedBy: result.matchedBy,
        topic: result.topic ? { id: result.topic.id, title: result.topic.title, file: result.topic.file } : null,
        content: result.served?.text ?? null,
        citation: result.citation ?? null,
        candidates: result.candidates.map((topic) => ({ id: topic.id, title: topic.title })),
        related: (result.related ?? []).map((topic) => ({ id: topic.id, title: topic.title })),
        handoff: result.handoff ?? null
      };
      this.render();
      await this.recordMetric({
        surface: 'help-center', intent: result.helpIntent,
        outcome: result.status === 'resolved' || result.status === 'index' ? 'resolved'
          : result.status === 'ambiguous' ? 'ambiguous' : result.status === 'not-found' ? 'no-match' : 'unavailable',
        topicId: result.topic?.id ?? null, matchedBy: result.matchedBy,
        latencyMs: result.latencyMs, answerBytes: result.served?.bytes ?? 0,
        actionCategory: origin === 'followup' ? 'followup-opened' : null
      });
    } catch {
      this.answer = {
        status: 'unavailable', question: query, intent: 'concept', matchedBy: 'unavailable',
        topic: null, content: null, citation: null, candidates: [], related: [], handoff: null
      };
      this.render();
    }
  }

  private async openTopic(topic: string | null): Promise<void> {
    if (!topic || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic)) return;
    await vscode.commands.executeCommand('singularityFlow.explainTopic', { id: `help:topic:${topic}` });
    await this.recordMetric({
      surface: 'help-center', intent: 'concept', outcome: 'resolved', topicId: topic,
      matchedBy: 'action', latencyMs: 0, answerBytes: 0, actionCategory: 'topic-opened'
    });
  }

  private async prefillAction(skill: string | null, topic: string | null): Promise<void> {
    if (!skill || !/^\/sf-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)
        || !topic || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic)) return;
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: `${skill} `,
      isPartialQuery: true
    });
    await this.recordMetric({
      surface: 'help-center', intent: 'procedure', outcome: 'resolved', topicId: topic,
      matchedBy: 'action', latencyMs: 0, answerBytes: 0, actionCategory: 'command-prefilled'
    });
  }

  private async commandCopied(topic: string | null): Promise<void> {
    if (!topic || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic)) return;
    await this.recordMetric({
      surface: 'help-center', intent: 'command-discovery', outcome: 'resolved', topicId: topic,
      matchedBy: 'action', latencyMs: 0, answerBytes: 0, actionCategory: 'command-copied'
    });
  }

  private async refreshMetrics(): Promise<void> {
    const root = activeRepositoryContext()?.root;
    if (!root) return;
    const status = await helpMetricsStatus(root).catch(() => null);
    if (!status) return;
    this.metrics = {
      enabled: status.enabled, count: status.count,
      outcomes: status.outcomes, intents: status.intents, topics: status.topics,
      unresolvedIntents: status.unresolvedIntents,
      ambiguousIntents: status.ambiguousIntents,
      noMatchIntents: status.noMatchIntents
    };
    this.render();
  }

  private async openLink(source: string | null, target: string | null): Promise<void> {
    try {
      const sources = this.document.topics.map((topic) => ({
        file: topic.sourceFile ?? 'HELP.md', content: topic.content
      }));
      if (this.answer?.status === 'resolved' && this.answer.topic && this.answer.content) {
        sources.push({ file: `docs/topics/${this.answer.topic.file}`, content: this.answer.content });
      }
      const link = await resolveHelpLink(this.manualRoot, source, target, sources);
      if (link.kind === 'external') await vscode.env.openExternal(vscode.Uri.parse(link.url));
      else await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(link.file));
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not open Help link: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Singularity Flow Help', helpCenterHtml(
      this.document, this.requested, this.answer, this.metrics
    ),
      contentSecurityPolicy(this.panel.webview, token), token, HELP_CENTER_SCRIPT, { nav: 'help' });
  }
}
