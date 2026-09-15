import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { CohereEmbeddings } from "@langchain/cohere";
import { CloudClient } from "chromadb";
import { Document } from "@langchain/core/documents";
import logger from "../utils/logger.js";
import { env, validateEnv, INGEST_REQUIRED } from "../config/env.js";

validateEnv(INGEST_REQUIRED);

// ---------- AWS S3 Setup ----------
const s3 = new S3Client({
  region: env.awsRegion || "us-east-1",
  credentials: {
    accessKeyId: env.awsAccessKeyId,
    secretAccessKey: env.awsSecretAccessKey,
  },
});

// Function to list *all* objects in the S3 bucket (even >1000)
async function listAllObjects(bucketName) {
  let keys = [];
  let ContinuationToken = undefined;

  while (true) {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken,
      })
    );

    if (response.Contents) {
      keys.push(...response.Contents.map((item) => item.Key));
    }

    if (!response.IsTruncated) break;
    ContinuationToken = response.NextContinuationToken;
  }

  return keys.filter(Boolean);
}

// Function to load CSV content from S3
async function loadCSVFromS3(bucket, key) {
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }));
    
    const csvContent = await response.Body.transformToString();
    
    // Simple CSV parsing - convert to text format
    const lines = csvContent.split('\n');
    const headers = lines[0];
    const rows = lines.slice(1).filter(row => row.trim());
    
    let content = `File: ${key}\nHeaders: ${headers}\n\nData:\n`;
    rows.forEach((row, index) => {
      if (row.trim() && index < 100) { // Limit to first 100 rows
        content += `Row ${index + 1}: ${row}\n`;
      }
    });
    
    return new Document({
      pageContent: content,
      metadata: {
        source: `s3://${bucket}/${key}`,
        type: 'csv',
        rows: rows.length
      }
    });
  } catch (error) {
    logger.error({ key, err: error }, "Error loading S3 object");
    return null;
  }
}

// ---------- Main ingestion ----------
async function ingestAllFromS3() {
  logger.info({ bucket: env.s3Bucket }, "Listing all files from S3 bucket");
  const keys = await listAllObjects(env.s3Bucket);
  logger.info({ count: keys.length }, "Found S3 files");

  const embeddings = new CohereEmbeddings({ 
    apiKey: env.cohereApiKey,
    model: "embed-english-v3.0"
  });
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });

  // Initialize ChromaDB cloud client
  const client = new CloudClient({
    apiKey: env.chromaApiKey,
    tenant: env.chromaTenant,
    database: env.chromaDatabase
  });

  // Get or create collection
  let collection;
  try {
    collection = await client.getCollection({
      name: "farming-documents"
    });
    logger.info("Using existing collection: farming-documents");
  } catch (error) {
    // Create collection without embedding function (we handle embeddings externally)
    collection = await client.createCollection({
      name: "farming-documents",
      metadata: { 
        description: "Agricultural data for Tamil Nadu farming assistant",
        embedding_provider: "cohere" 
      }
    });
    logger.info("Created new collection: farming-documents");
  }

  for (const key of keys) {
    try {
      logger.info({ key }, "Processing S3 object");

      // Load document from S3 using our custom CSV loader
      const doc = await loadCSVFromS3(env.s3Bucket, key);
      if (!doc) {
        logger.warn({ key }, "Failed to load S3 object");
        continue;
      }

      // Split into chunks
      const splitDocs = await textSplitter.splitDocuments([doc]);
      logger.info({ key, chunks: splitDocs.length }, "Split into chunks");

      if (splitDocs.length === 0) {
        logger.warn({ key }, "No chunks created");
        continue;
      }

      // Generate embeddings for chunks
      const documents = [];
      const metadatas = [];
      const ids = [];

      for (let i = 0; i < splitDocs.length; i++) {
        const chunk = splitDocs[i];
        documents.push(chunk.pageContent);
        metadatas.push({
          source: `s3://${env.s3Bucket}/${key}`,
          chunk_index: i,
          filename: key
        });
        ids.push(`${key}_chunk_${i}_${Date.now()}`);
      }

      // Get embeddings from Cohere
      const embeddingResults = await embeddings.embedDocuments(documents);

      // Add to ChromaDB collection
      await collection.add({
        ids: ids,
        embeddings: embeddingResults,
        metadatas: metadatas,
        documents: documents
      });

      logger.info({ key, chunks: splitDocs.length }, "Added to ChromaDB cloud");
    } catch (err) {
      logger.error({ key, err }, "Error processing S3 object");
    }
  }

  logger.info("All S3 files ingested successfully");
}

// Run the ingestion
ingestAllFromS3().catch((err) => {
  logger.error({ err }, "Fatal ingestion error");
  process.exit(1);
});
