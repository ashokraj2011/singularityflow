declare module '*/linked-folder-notice.mjs' {
  export interface LinkedFolder { opened: string; real: string }
  export function shellPath(value: string, platform?: string): string;
  export function linkedFolderNotice(linked: LinkedFolder, platform?: string): {
    cause: 'linked-folder'; opened: string; real: string; command: string; because: string; fix: string;
  };
  export function linkedFolders(opened: readonly string[], realpath: (target: string) => Promise<string>,
    caseInsensitive?: boolean): Promise<LinkedFolder[]>;
  export function usesSflowFolder(folder: string, exists: (target: string) => Promise<boolean>): Promise<boolean>;
  export function linkedFolderPrompt(linked: LinkedFolder, options?: { multiRoot?: boolean; platform?: string }): {
    message: string; action: string; status: string; tooltip: string; newWindow: boolean;
  };
}
