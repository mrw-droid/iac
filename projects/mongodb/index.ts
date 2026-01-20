import * as pulumi from "@pulumi/pulumi";
import * as mongodbatlas from "@pulumi/mongodbatlas";

const config = new pulumi.Config();

// Required configuration
const atlasOrgId = config.require("atlasOrgId");
const dbPassword = config.requireSecret("atlasDbPassword");
const dbUsername = config.get("dbUsername") ?? "appuser";
const dbName = config.get("dbName") ?? "website";

// Create an Atlas Project
const project = new mongodbatlas.Project("website-project", {
  name: `website-${pulumi.getStack()}`,
  orgId: atlasOrgId,
});

// Create a free M0 cluster
const cluster = new mongodbatlas.Cluster("website-cluster", {
  projectId: project.id,
  name: `website-${pulumi.getStack()}`,

  // M0 Free Tier settings
  providerName: "TENANT",
  backingProviderName: "GCP",
  providerRegionName: "CENTRAL_US",
  providerInstanceSizeName: "M0",
});

// Create a database user
const dbUser = new mongodbatlas.DatabaseUser("app-user", {
  projectId: project.id,
  username: dbUsername,
  password: dbPassword,
  authDatabaseName: "admin",
  roles: [
    {
      roleName: "readWrite",
      databaseName: dbName,
    },
  ],
});

// Allow connections from anywhere (Vercel IPs are dynamic)
// The connection is still authenticated and encrypted via TLS
const ipAccessList = new mongodbatlas.ProjectIpAccessList("allow-all", {
  projectId: project.id,
  cidrBlock: "0.0.0.0/0",
  comment: "Allow connections from anywhere (Vercel serverless)",
});

// Construct the connection string
export const connectionString = pulumi.interpolate`mongodb+srv://${dbUsername}:${dbPassword}@${cluster.connectionStrings[0].standardSrv?.replace("mongodb+srv://", "")}/${dbName}?retryWrites=true&w=majority`;

// Export other useful values
export const projectId = project.id;
export const clusterName = cluster.name;
export const clusterState = cluster.stateName;
