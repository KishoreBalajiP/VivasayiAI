import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { CohereEmbeddings } from "@langchain/cohere";
import { CloudClient } from "chromadb";
import { Document } from "@langchain/core/documents";
import logger from "../utils/logger.js";
import { env, validateEnv, INGEST_REQUIRED } from "../config/env.js";
import AIConfig from "../src/ai/AIConfig.js";
import { shouldIngestKey, csvToText, chunkId } from "./ingestHelpers.js";

// Run only when executed directly (`npm run ingest`), never on import.
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) validateEnv(INGEST_REQUIRED);

const MAX_ROWS_PER_FILE = Number(process.env.RAG_MAX_ROWS_PER_FILE) || 100;
const INCLUDE_PREFIX = process.env.RAG_INGEST_PREFIX || "";

// ---------- AWS S3 Setup ----------
const s3 = isMain ? new S3Client({
  region: env.awsRegion || "us-east-1",
  credentials: {
    accessKeyId: env.awsAccessKeyId,
    secretAccessKey: env.awsSecretAccessKey,
  },
}) : null;

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

// Load one CSV from S3 as a single text document.
async function loadCSVFromS3(bucket, key) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const csvContent = await response.Body.transformToString();
    const { text, rowCount, usedRows, truncated } = csvToText({ key, csv: csvContent, maxRows: MAX_ROWS_PER_FILE });
    if (!text) return null;
    if (truncated) {
      logger.warn({ key, rowCount, usedRows }, "CSV truncated to RAG_MAX_ROWS_PER_FILE; remaining rows are not ingested");
    }
    return new Document({
      pageContent: text,
      metadata: { source: `s3://${bucket}/${key}`, type: "csv", rows: rowCount },
    });
  } catch (error) {
    logger.error({ key, err: error }, "Error loading S3 object");
    return null;
  }
}

// ---------- Main ingestion ----------
async function ingestAllFromS3() {
  logger.info({ bucket: env.s3Bucket }, "Listing all files from S3 bucket");
  const allKeys = await listAllObjects(env.s3Bucket);
  // Only knowledge CSVs: never farmer uploads, land documents or claim evidence (see shouldIngestKey).
  const keys = allKeys.filter((key) => shouldIngestKey(key, { uploadPrefix: env.uploadStoragePrefix, includePrefix: INCLUDE_PREFIX }));
  logger.info({ listed: allKeys.length, ingesting: keys.length }, "Found S3 files");

  const embeddings = new CohereEmbeddings({ 
    apiKey: env.cohereApiKey,
    // The same model the chat side queries with: a different one here produces vectors the
    // query side cannot compare against.
    model: AIConfig.embeddingModel,
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
        ids.push(chunkId({ key, index: i, text: chunk.pageContent }));
      }

      // Get embeddings from Cohere
      const embeddingResults = await embeddings.embedDocuments(documents);

      // Add to ChromaDB collection
      // upsert: re-running on an unchanged file replaces identical ids instead of duplicating chunks.
      await collection.upsert({
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

if (isMain) {
  ingestAllFromS3().catch((err) => {
    logger.error({ err }, "Fatal ingestion error");
    process.exit(1);
  });
}
