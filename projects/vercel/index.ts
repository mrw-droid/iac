import * as pulumi from "@pulumi/pulumi";
import * as vercel from "@pulumiverse/vercel";

const config = new pulumi.Config();
const stack = pulumi.getStack();

// Stack references for cross-project values
const sharedRef = new pulumi.StackReference(`shared-${stack}`, {
  name: pulumi.interpolate`${pulumi.getOrganization()}/shared/${stack}`,
});

const mongodbRef = new pulumi.StackReference(`mongodb-${stack}`, {
  name: pulumi.interpolate`${pulumi.getOrganization()}/mongodb/${stack}`,
});

// Get secrets from other stacks
const tailnetSecret = sharedRef.getOutput("tailnetSecret");
const mongodbConnectionString = mongodbRef.getOutput("connectionString");

// Configuration
const githubRepo = config.require("githubRepo");
const domain = config.get("domain");
const productionBranch = config.get("productionBranch") ?? "main";

// Create the Vercel project
const project = new vercel.Project("website", {
  name: `website-${stack}`,
  framework: "nextjs",
  gitRepository: {
    type: "github",
    repo: githubRepo,
  },
  buildCommand: "npm run build",
  rootDirectory: null,
  serverlessFunctionRegion: "iad1", // US East (Washington, D.C.)
});

// Set environment variables
const tailnetSecretEnv = new vercel.ProjectEnvironmentVariable("tailnet-secret", {
  projectId: project.id,
  key: "TAILNET_SECRET",
  value: tailnetSecret,
  targets: ["production", "preview"],
});

const mongodbEnv = new vercel.ProjectEnvironmentVariable("mongodb-uri", {
  projectId: project.id,
  key: "MONGODB_URI",
  value: mongodbConnectionString,
  targets: ["production", "preview"],
});

// Add custom domain if configured
const customDomain = domain
  ? new vercel.ProjectDomain("custom-domain", {
      projectId: project.id,
      domain: domain,
    })
  : undefined;

// Add www subdomain if custom domain is set
const wwwDomain = domain
  ? new vercel.ProjectDomain("www-domain", {
      projectId: project.id,
      domain: `www.${domain}`,
      redirect: domain, // Redirect www to apex
      redirectStatusCode: 308,
    })
  : undefined;

// Exports
export const projectId = project.id;
export const projectName = project.name;
export const vercelDomain = pulumi.interpolate`${project.name}.vercel.app`;
export const customDomainName = customDomain?.domain;
export const gitRepository = githubRepo;
