import { App, Tags } from 'aws-cdk-lib';
import { readDeployContext } from '../lib/deploy-context';
import { DevlogStack } from '../lib/devlog-stack';

const app = new App();

// Throws MissingDeployContextError, failing synthesis, when any required value is absent.
const deployContext = readDeployContext(app);

// Req 10.7: an identical project tag and environment tag on every taggable resource. Applied at the
// app scope so a construct added in any later task inherits both without a per-resource opt-in.
Tags.of(app).add('project', 'devlog-narrator');
Tags.of(app).add('environment', deployContext.environment);

// The stack is environment-agnostic on purpose: no account or region is baked into the template, so
// synthesis needs no credentials and produces the same bytes on any machine (Req 12.8). The target
// account and region come from the ambient credentials at deploy time (Req 12.5).
new DevlogStack(app, 'DevlogNarratorStack', {
  stackName: `devlog-narrator-${deployContext.environment}`,
  description: 'Devlog Narrator: single-author build-in-public devlog',
  deployContext,
});

app.synth();
