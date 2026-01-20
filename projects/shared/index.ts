import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

const config = new pulumi.Config();

// Allow user to provide their own tailnet secret, otherwise generate one
const providedTailnetSecret = config.getSecret("tailnetSecret");

const generatedSecret = new random.RandomPassword("tailnet-secret", {
  length: 64,
  special: false,
});

// Use provided secret if available, otherwise use generated one
export const tailnetSecret = providedTailnetSecret ?? generatedSecret.result;

// Export the stack name for reference
export const stackName = pulumi.getStack();
