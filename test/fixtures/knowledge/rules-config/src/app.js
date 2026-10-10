export function applyRules(rules, facts) {
  return rules.filter((rule) => rule.matches(facts));
}
