/** One explicit headless composition. Operations still enter the SDK registry exactly once. */
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {validateSourceUnit,validateSourceContentReader} from '../foundation/source-snapshot.mjs';
import {validateSourceControlReader} from '../foundation/source-control.mjs';
import {validateNamespaceStore,NAMESPACE_STORE_METHODS} from '../sda/namespace/contract.mjs';
import {namespaceScope,namespaceIdentifier,exactObject} from '../sda/namespace/values.mjs';
import {validateContentStore,CONTENT_STORE_METHODS} from '../sda/content/contract.mjs';
import {createNamespaceReadPorts} from './namespace-reader.mjs';
import {createNamespaceProjectPorts} from './namespace-project.mjs';
import {createNamespaceConfigurationPorts} from './namespace-configuration.mjs';
import {createNamespaceStoryPorts} from './namespace-story.mjs';
import {createNamespaceSourceBindingPort} from './namespace-source.mjs';
import {createNamespacePreparationRuntime} from './namespace-preparation.mjs';
import {createNamespacePublicationPort} from './namespace-publication.mjs';
import {createNamespaceSubmissionPorts} from './namespace-submission.mjs';
import {createNamespaceApprovalPorts} from './namespace-approval.mjs';
import {createNamespaceRoutingChoicePorts} from './namespace-routing-choice.mjs';
import {createNamespacePhaseChecksPort} from './namespace-phase-checks.mjs';
import {createNamespaceSourceInspectionPort} from './namespace-source-inspection.mjs';
import {createNamespaceSourceRetentionPort} from './namespace-source-retention.mjs';
import {createNamespaceSourceBaselinePort} from './namespace-source-baseline.mjs';
import {createNamespaceDeliveryInspectionPort} from './namespace-delivery-inspection.mjs';
import {createNamespaceSourceControlPort} from './namespace-source-control.mjs';
import {createNamespaceClarificationPorts} from './namespace-clarifications.mjs';
import {createNamespacePhaseEntryPorts} from './namespace-phase-entry.mjs';
const invalid=message=>{throw new SingularityFlowError(message,{code:'ENGINE_INPUT_INVALID'});};
function captured(port,validate,methods) {
  validate(port);
  return Object.freeze({descriptor:structuredClone(port.descriptor),...Object.fromEntries(methods.map(name=>[name,port[name].bind(port)]))});
}

export function createNamespaceEngine(options={}) {
  const fields=['records','content','scope','workId','authority','access','clock','working','localContent','sources','modelEnabled','notice','checks','sourceReaders','sourceControlReaders'];
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!fields.includes(key)))invalid('Use explicit namespace Engine bindings and capabilities.');
  options=Object.fromEntries(fields.map(key=>[key,options[key]]));
  const scope=namespaceScope(options.scope),workId=namespaceIdentifier(options.workId,'Story ID');
  exactObject(options.authority,['id','epoch']);
  const authority=Object.freeze({id:namespaceIdentifier(options.authority.id,'Authority ID'),epoch:options.authority.epoch});
  if(!Number.isSafeInteger(authority.epoch)||authority.epoch<1||typeof options.access?.current!=='function'
    ||typeof options.clock?.now!=='function'||options.modelEnabled!==undefined&&typeof options.modelEnabled!=='boolean'
    ||options.notice!==undefined&&typeof options.notice!=='function')invalid('An Engine needs an explicit authority, access, clock and optional execution capabilities.');
  const records=captured(options.records,validateNamespaceStore,NAMESPACE_STORE_METHODS),content=captured(options.content,validateContentStore,CONTENT_STORE_METHODS);
  const access=Object.freeze({current:options.access.current.bind(options.access)}),clock=Object.freeze({now:options.clock.now.bind(options.clock)});
  let working=null;
  if(options.working!=null) {
    exactObject(options.working,['records','content']);
    working={records:captured(options.working.records,validateNamespaceStore,NAMESPACE_STORE_METHODS),
      content:captured(options.working.content,validateContentStore,CONTENT_STORE_METHODS)};
  }
  const localContent=options.localContent==null?working?.content??null:captured(options.localContent,validateContentStore,CONTENT_STORE_METHODS);
  if(!Array.isArray(options.sources??[])||(options.sources??[]).length>32)invalid('Source units must be an explicit bounded list.');
  const sources=Object.freeze((options.sources??[]).map(unit=>{
    const descriptor=structuredClone(validateSourceUnit(unit));
    return Object.freeze({descriptor,capture:unit.capture.bind(unit)});
  }));
  if(!Array.isArray(options.sourceReaders??[])||(options.sourceReaders??[]).length>32)invalid('Source content readers must be an explicit bounded list.');
  const sourceReaders=Object.freeze((options.sourceReaders??[]).map(reader=>Object.freeze({descriptor:validateSourceContentReader(reader),read:reader.read.bind(reader)})));
  if(!Array.isArray(options.sourceControlReaders??[])||(options.sourceControlReaders??[]).length>32)invalid('Source-control readers must be an explicit bounded list.');
  const sourceControlReaders=Object.freeze((options.sourceControlReaders??[]).map(reader=>Object.freeze({descriptor:validateSourceControlReader(reader),capture:reader.capture.bind(reader)})));
  const common={records,content,scope,workId,authority,access,clock,localContent,sources,
    modelEnabled:options.modelEnabled??true,notice:options.notice??(()=>{}),checks:options.checks,sourceReaders,sourceControlReaders};
  const runtime=working?createNamespacePreparationRuntime({...common,localRecords:working.records,localContent:working.content}):null;
  const ports={...createNamespaceReadPorts(common,{authority}),
    ...(authority.epoch===1?createNamespaceProjectPorts(common):{}),
    ...createNamespaceConfigurationPorts(common),...createNamespaceStoryPorts(common),
    sourceBinding:createNamespaceSourceBindingPort(common),...(runtime?.ports??{}),...createNamespaceClarificationPorts(common),...createNamespacePhaseEntryPorts(common,runtime),
    phaseSourceInspection:createNamespaceSourceInspectionPort(common,runtime),
    phaseSourceRetention:createNamespaceSourceRetentionPort(common,runtime),
    phaseSourceControlRetention:createNamespaceSourceControlPort(common,runtime),
    sourceBaselineRetention:createNamespaceSourceBaselinePort(common),
    phaseDeliveryInspection:createNamespaceDeliveryInspectionPort(common,runtime),
    publication:createNamespacePublicationPort(common,runtime),...createNamespaceSubmissionPorts(common),
    ...createNamespaceApprovalPorts(common),...createNamespaceRoutingChoicePorts(common),
    ...(options.checks?{phaseChecks:createNamespacePhaseChecksPort(common,runtime)}:{})};
  return createEngine({ports});
}
