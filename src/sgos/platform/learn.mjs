import { SingularityFlowError } from '../../util.mjs';

function fail(message, code = 'SGOS_LEARN_INVALID') {
  throw new SingularityFlowError(message, { code });
}

function role(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value)) {
    fail('Learning role must use lower-case kebab case.', 'SGOS_LEARN_ROLE_INVALID');
  }
  return value;
}

export function createReadOnlyLessonCatalog({ packRegistry }) {
  if (!packRegistry || packRegistry.profile !== 'signed-declarative-local-v1'
      || typeof packRegistry.listActive !== 'function') {
    fail('Learning catalog requires the signed active Capability Pack registry.', 'SGOS_LEARN_PACK_REGISTRY_REQUIRED');
  }

  async function visibleLessons(requestedRole) {
    const normalizedRole = role(requestedRole);
    const packs = await packRegistry.listActive();
    const lessons = [];
    for (const pack of packs) {
      for (const lesson of pack.lessons) {
        if (!lesson.roles.includes(normalizedRole)) continue;
        lessons.push(Object.freeze({
          lessonId: lesson.lessonId,
          title: lesson.title,
          role: normalizedRole,
          contentSha256: lesson.contentSha256,
          packId: pack.packId,
          packSha256: pack.recordSha256,
          domain: pack.domain
        }));
      }
    }
    lessons.sort((left, right) => left.lessonId < right.lessonId ? -1 : left.lessonId > right.lessonId ? 1 : 0);
    return Object.freeze(lessons);
  }

  return Object.freeze({
    profile: 'read-only-role-catalog-v1',

    async list({ role: requestedRole }) {
      return visibleLessons(requestedRole);
    },

    async show({ role: requestedRole, lessonId }) {
      if (typeof lessonId !== 'string' || !lessonId) fail('lessonId is required.');
      const matches = (await visibleLessons(requestedRole)).filter((lesson) => lesson.lessonId === lessonId);
      if (!matches.length) fail(`Lesson '${lessonId}' is not available for this role.`, 'SGOS_LEARN_LESSON_UNAVAILABLE');
      if (matches.length > 1) fail(`Lesson '${lessonId}' is ambiguous across active packs.`, 'SGOS_LEARN_LESSON_AMBIGUOUS');
      return matches[0];
    }
  });
}
