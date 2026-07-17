#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node list-external-secrets.js <env> <project-root-path>');
  console.error('Example: node list-external-secrets.js dev-experimental-argocd-interop-apps-post-sync-hook /path/to/project');
  process.exit(1);
}

const awsSmLabels = {
  'current': 'AWSCURRENT',
  'previous': 'AWSPREVIOUS'
};

const secretValueTypes = {
    json: 'json',
    text: 'text',
    binary: 'binary',
    empty: 'empty'
};

const env = args[0];
const projectRoot = path.resolve(args[1]);

if (!fs.existsSync(projectRoot)) {
  console.error(`Error: Project root path does not exist: ${projectRoot}`);
  process.exit(1);
}

const microservicesPath = path.join(projectRoot, 'microservices');
const jobsPath = path.join(projectRoot, 'jobs');
const errorLog = [];
const outputPath = path.join(projectRoot, `external-secrets-analysis`);

fs.mkdirSync(outputPath, { recursive: true });

function getAwsClient() {
  return new SecretsManagerClient({});
}

function recordError(message) {
  errorLog.push(message);
}

/**
 * Recursively find all values.yaml files in directories matching the env pattern
 */
function findValuesFiles(basePath, env) {
  const results = [];

  if (!fs.existsSync(basePath)) {
    return results;
  }

  const entries = fs.readdirSync(basePath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const fullPath = path.join(basePath, entry.name);
      
      // Check if this directory contains env-specific config
      const envPath = path.join(fullPath, env);
      if (fs.existsSync(envPath)) {
        const valuesFile = path.join(envPath, 'values.yaml');
        if (fs.existsSync(valuesFile)) {
          results.push({ file: valuesFile, service: entry.name });
        }
      }

      // Also check for values.yaml directly in the env folder
      const valuesFile = path.join(fullPath, 'values.yaml');
      if (entry.name === env && fs.existsSync(valuesFile)) {
        results.push({ file: valuesFile, service: 'root-config' });
      }
    }
  }

  return results;
}

/**
 * Extract external secrets data from values.yaml content
 */
function extractExternalSecrets(yamlContent, filePath) {
  const results = [];

  try {
    const data = yaml.parse(yamlContent);
    
    if (data && data.externalSecrets && Array.isArray(data.externalSecrets.data)) {
      for (const secret of data.externalSecrets.data) {
        if (secret.remoteRef) {
          results.push({
            file: filePath,
            secretKey: secret.secretKey || 'N/A',
            key: secret.remoteRef.key || 'N/A',
            property: secret.remoteRef.property || 'N/A',
            version: secret.remoteRef.version ? secret.remoteRef.version.substring(secret.remoteRef.version.indexOf('/') + 1) : awsSmLabels.current, // strip "uuid/" prefix if present
            conversionStrategy: secret.remoteRef.conversionStrategy || 'Default',
            decodingStrategy: secret.remoteRef.decodingStrategy || 'None'
          });
        }
      }
    }
  } catch (err) {
    const message = `Error parsing YAML file ${filePath}: ${err.message}`;
    console.error(message);
    recordError(message);
  }

  return results;
}

async function parseSecretValue(secretValue, isString) {
  if (!secretValue) {
    return { raw: secretValue, parsed: null, type: secretValueTypes.empty };
  }

  if (isString) {
    // Try to parse as JSON
    try {
      const parsed = JSON.parse(secretValue);
      return { raw: secretValue, parsed, type: secretValueTypes.json };
    } catch (_jsonErr) {
      // Not JSON, treat as plain text
      return { raw: secretValue, parsed: null, type: secretValueTypes.text };
    }
  } else {
    // Binary data
    return { raw: secretValue, parsed: null, type: secretValueTypes.binary };
  }
}

async function getLatestSecretVersion(client, secretId) {
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    console.log(`\n ➜ Fetched secret metadata for secret ${secretId}, version: ${response.VersionId} \n`);
    
    const isString = !!response.SecretString;
    const rawValue = response.SecretString || response.SecretBinary;
    const parsedValue = await parseSecretValue(rawValue, isString);
    
    return {
        versionId: response.VersionId,
        versionStages: response.VersionStages,
        value: parsedValue
    }
  } catch (err) {
    const message = `Error fetching latest version for secret ${secretId}: ${err.message}`;
    console.error(`\n  ❌ ${message}\n`);
    recordError(message);
    return null;
 }
}

async function validateAwsCredentials(client) {
  try {
    const provider = client.config.credentials;
    if (typeof provider === 'function') {
      await provider();
    }
    return true;
  } catch (err) {
    const message = `AWS credentials validation failed: ${err.message}`;
    console.error(`\n\t❌ ${message}\n`);
    recordError(message);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  console.log(`\n🧐 Scanning for External Secrets in environment: ${env}\n`);
  console.log(`  Project root: ${projectRoot}\n`);
  console.log(`  Reports Output path: ${outputPath}\n`);

  if (!process.env.AWS_PROFILE) {
    console.warn('⚠️  AWS_PROFILE is not set. The AWS SDK will use the default credential chain.');
  }

  const microservicesFiles = findValuesFiles(microservicesPath, env);
  const jobsFiles = findValuesFiles(jobsPath, env);

  const allFiles = [...microservicesFiles, ...jobsFiles];

  if (allFiles.length === 0) {
    console.log(`⚠️  No values.yaml files found for environment: ${env}`);
    console.log(`Please ensure that you have the correct environment name and that values.yaml files are present in the expected directories.`);
    console.log(`......`);
    console.log(`Exiting without generating report.`);
    return;
  }

  console.log(`👀 Found ${allFiles.length} values.yaml files\n`);

  let secretsFound = 0;
  const allSecrets = [];

  const awsClient = getAwsClient();
  const credsOk = await validateAwsCredentials(awsClient);
  if (!credsOk) {
    return;
  }

  for (const { file, service } of allFiles) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const secrets = extractExternalSecrets(content, file);

      if (secrets.length > 0) {
        console.log(`\n${'='.repeat(100)}`);
        console.log(`🔐 Found ${secrets.length} external secrets in service: ${service} \n`);
        console.log(`💾 ${service}`);
        console.log(`   File: ${path.relative(projectRoot, file)}\n`);
        console.log(`${'='.repeat(100)}\n`);

        for (const [index, secret] of secrets.entries()) {
          console.log(`\n🔑 Secret ${index + 1} of ${secrets.length}`);
          
          if (secret.version &&  (secret.version == awsSmLabels.current || secret.version == awsSmLabels.previous)) { 
            console.log(`  ❌ version: ${secret.version} is a label, not a specific version ID. Please specify an explicit version ID to ensure stability.`);
            secret.misconfigured = true;
          } else {
            secret.misconfigured = false;
          }
          console.log(` . key: ${secret.key}`);
          console.log(` . property: ${secret.property}`);
          console.log(` . version: ${secret.version}`);
            
          let latestVersion = await getLatestSecretVersion(awsClient, secret.key);
          
          if (!latestVersion) {
            console.log(`  ⚠️  Warning: Could not fetch latest version for secret ${secret.key}, skipping version comparison`);
            secret.error = true;
            allSecrets.push(secret);
            secretsFound++;
            
            continue;
          }

          secret.latestVersion = latestVersion.versionId;
          secret.stages = latestVersion.versionStages;
          
          if (latestVersion.value.type === secretValueTypes.json) {
              if (!latestVersion.value.parsed[secret.property]) {
                  console.log(`  ⚠️  Warning: Property ${secret.property} not found in the latest version of secret ${secret.key}`);
                  secret.error = true;
              }
          } else if (latestVersion.value.type === secretValueTypes.text) {
              if (latestVersion.value.raw != secret.property) {
                  console.log(`  ⚠️  Warning: Property ${secret.property} does not match the latest value of secret ${secret.key}`);
                  secret.error = true;
              }
          }
          if (!secret.error) {
              if (secret.latestVersion && secret.latestVersion !== secret.version) {
                  secret.updateStatus = '❌ Outdated';
                  secret.updated = false;
                  console.log(`  ⚠️  Warning: Latest version for secret ${secret.key} is ${secret.latestVersion}, which differs from specified version ${secret.version}`);
              } else {
                  secret.updateStatus = '✅ Up-to-date';
                  secret.updated = true;
                  console.log(`  ✅ Latest version for secret ${secret.key} is ${secret.latestVersion}`);
              }
          }

          
          allSecrets.push(secret);
          secretsFound++;
        }
      }
    } catch (err) {
      const message = `Error reading file ${file}: ${err.message}`;
      console.error(`❌ ${message}`);
      recordError(message);
    }
  }
  console.log(`\n${'='.repeat(120)}\n`);

  let summaryEntries = {};
  summaryEntries["Total files scanned"] = allFiles.length;
  summaryEntries["Total secrets found"] = secretsFound;
  summaryEntries["Total secrets aligned"] = allSecrets.filter(secret => secret.updated).length;
  summaryEntries["Total secrets outdated"] = allSecrets.filter(secret => !secret.updated).length;
  summaryEntries["Total secrets misconfigured"] = allSecrets.filter(secret => secret.misconfigured).length;
  summaryEntries["Total secrets with errors"] = allSecrets.filter(secret => secret.error).length;

  console.log(`\t\t📝 Summary`);
  console.table(summaryEntries); 
  
  // Export to CSV if secrets found
  if (secretsFound > 0) {
    console.log(`\n📊 Exporting secrets data to CSV and JSON report\n\n`);
    generateCSV(allSecrets);
    generateJsonReport(allSecrets);
    
    console.log(`\n${'='.repeat(120)}\n`);

    // get all the outdated and misconfigured secrets and update the corresponding files with a comment and update the version to the latest version
    for (const secret of allSecrets) {
        if (!secret.updated || secret.misconfigured || secret.error) {
            try {
                let updated = false;
                let content = fs.readFileSync(secret.file, 'utf8');
                const relativePath = path.relative(projectRoot, secret.file);

                // find secret in the content and update the secret version to the latest version
                const doc = yaml.parseDocument(content);
                const data = doc.getIn(["externalSecrets", "data"]);

                data.items.forEach(item => {
                    const remoteRef = item.get("remoteRef");
                    if (!remoteRef) return;
                    
                    const secretKey = item.get("secretKey");
                    const key = remoteRef.get("key");
                    const property = remoteRef.get("property");
                    if (secretKey === secret.secretKey && key === secret.key && property === secret.property) {
                        if (!secret.error && secret.latestVersion) {
                            updated = true;
                            remoteRef.set("version", `uuid/${secret.latestVersion}`);
                            return;
                        }
                    }
                });
                fs.writeFileSync(relativePath, doc.toString());

                if (!updated) {
                    console.warn(`⚠️  Could not find secret entry in file ${relativePath} for secret ${secret.key} / ${secret.property} to update version and add comments`);
                }
                
            } catch (err) {
                const message = `Error updating file ${secret.file} for secret ${secret.key} / ${secret.property}: ${err.message}`;
                console.error(`❌ ${message}`);
                recordError(message);
            }
        } 
    }
  }


  if (errorLog.length > 0) {
    const errorPath = path.join(outputPath, `external-secrets-errors-${env}.log`);
    fs.writeFileSync(errorPath, `${errorLog.join('\n')}\n`);
    console.log(`\n\n⚠️  Errors written to: ${errorPath}\n`);
  }
}

/**
 * Generate CSV from secrets data
 */
function generateCSV(secrets) {
  const csvPath = path.join(outputPath, `external-secrets-${env}.csv`);
  
  const headers = ['Service', 'File', 'SecretKey', 'Key', 'Property', 'Status', 'Version', 'LatestVersion', 'VersionStages' , 'Misconfigured', 'Error'];
  const rows = secrets.map(secret => [
    path.dirname(secret.file).split(path.sep).slice(-2)[0],
    path.relative(process.cwd(), secret.file),
    secret.secretKey,
    secret.key,
    secret.property,
    secret.updateStatus,
    secret.version,
    secret.latestVersion,
    secret.stages,
    secret.misconfigured ? '❌ Yes' : 'No',
    secret.error ? '❌ Yes' : 'No'
  ]);

  const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');

  fs.writeFileSync(csvPath, csv);
  console.log(`✅ CSV exported to: ${csvPath}\n`);
}

function generateJsonReport(secrets) {
    const mapped = secrets.map(secret => {
        return {
            file: secret.file,
            secretKey: secret.secretKey,
            key: secret.key,
            property: secret.property,
            configuredVersion: secret.version,
            latestVersion: secret.latestVersion,
            updated: secret.updated,
            misconfigured: secret.misconfigured,
            error: secret.error
        } ;
    });
    //group secrets by filepath
    const groupedAll = mapped.reduce((acc, secret) => {
        const relativePath = path.relative(projectRoot, secret.file);
        if (!acc[relativePath]) {
            acc[relativePath] = [];
        }
        acc[relativePath].push(secret);
        return acc;
    }, {}); 

    const groupedOutdated = mapped.filter(secret => !secret.updated).reduce((acc, secret) => {
        const relativePath = path.relative(projectRoot, secret.file);
        if (!acc[relativePath]) {
            acc[relativePath] = [];
        }
        acc[relativePath].push(secret);
        return acc;
    }, {}); 
    
    const groupedMisconfigured = mapped.filter(secret => secret.misconfigured).reduce((acc, secret) => {
        const relativePath = path.relative(projectRoot, secret.file);
        if (!acc[relativePath]) {
            acc[relativePath] = [];
        }
        acc[relativePath].push(secret);
        return acc;
    }, {});

    const groupedError = mapped.filter(secret => secret.error).reduce((acc, secret) => {
        const relativePath = path.relative(projectRoot, secret.file);
        if (!acc[relativePath]) {
            acc[relativePath] = [];
        }
        acc[relativePath].push(secret);
        return acc;
    }, {}); 

    const reportPath = path.join(outputPath, `external-secrets-report-all-${env}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(groupedAll, null, 2));
    
    const reportPathOutdated = path.join(outputPath, `external-secrets-report-outdated-${env}.json`);
    fs.writeFileSync(reportPathOutdated, JSON.stringify(groupedOutdated, null, 2));
    
    const reportPathMisconfigured = path.join(outputPath, `external-secrets-report-misconfigured-${env}.json`);
    fs.writeFileSync(reportPathMisconfigured, JSON.stringify(groupedMisconfigured, null, 2));

    const reportPathError = path.join(outputPath, `external-secrets-report-error-${env}.json`);
    fs.writeFileSync(reportPathError, JSON.stringify(groupedError, null, 2));

    console.log(`✅ JSON report exported to: \n  ⬩ ${reportPath}\n  ⬩ ${reportPathOutdated}\n  ⬩ ${reportPathMisconfigured}\n  ⬩ ${reportPathError}\n`);
}

main().catch(err => {
  const message = `Fatal error: ${err.message}`;
  console.error(`❌ ${message}`);
  recordError(message);
  if (errorLog.length > 0) {
    const errorPath = path.join(projectRoot, `external-secrets-errors-${env}.log`);
    fs.writeFileSync(errorPath, `${errorLog.join('\n')}\n`);
  }
  process.exit(1);
});
