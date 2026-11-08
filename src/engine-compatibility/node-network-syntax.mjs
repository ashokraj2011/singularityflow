/** Native address/subnet value primitives only. No DNS, sockets, credentials or configuration reads. */
import { BlockList, isIP } from 'node:net';
import { NETWORK_ADDRESS_SYNTAX_PROFILE } from '../kernel/configuration-policy.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';

const compiledSubnets = /* @__PURE__ */ new WeakMap();

export const NODE_NETWORK_ADDRESS_SYNTAX = /* @__PURE__ */ Object.freeze({
  profile: NETWORK_ADDRESS_SYNTAX_PROFILE,
  isIP,
  containsSubnets(address, family, subnets) {
    if (!Array.isArray(subnets) || !Object.isFrozen(subnets) || !['ipv4', 'ipv6'].includes(family)) {
      throw new SingularityFlowError('Subnet syntax requires frozen subnet data and an exact address family.', { code: 'ENGINE_NETWORK_SUBNET_INPUT_INVALID' });
    }
    let families = compiledSubnets.get(subnets);
    if (!families) { families = new Map(); compiledSubnets.set(subnets, families); }
    let compiled = families.get(family);
    if (!compiled) {
      if (subnets.some(row => !Array.isArray(row) || !Object.isFrozen(row) || row.length !== 2
          || typeof row[0] !== 'string' || !Number.isSafeInteger(row[1]))) {
        throw new SingularityFlowError('Subnet syntax requires frozen address/prefix pairs.', { code: 'ENGINE_NETWORK_SUBNET_INPUT_INVALID' });
      }
      compiled = new BlockList();
      for (const [network, prefix] of subnets) compiled.addSubnet(network, prefix, family);
      families.set(family, compiled);
    }
    return compiled.check(address, family);
  }
});
