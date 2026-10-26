export type StoryCreator = string | { name?: string | null; login?: string | null; githubLogin?: string | null; email?: string | null } | null;
export function storyCreatorName(createdBy: unknown): string | null;
export function compareStoryCreation(left: { createdAt?: string | null }, right: { createdAt?: string | null }): number;
