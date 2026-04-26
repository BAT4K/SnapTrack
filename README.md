# ⚡ SnapTrack.AI // Serverless Calorie Intelligence

SnapTrack.AI is an enterprise-grade, multi-cloud serverless application that completely automates calorie and macronutrient tracking. 

By utilizing edge-ingestion via iOS Shortcuts, the architecture bypasses traditional API payload limits, routing raw image data directly into AWS for processing by a highly-available, multi-model AI pipeline (Google Gemini + Groq/Llama 3). 

![Architecture](https://img.shields.io/badge/Architecture-Event--Driven-orange) ![Status](https://img.shields.io/badge/Status-Production-success) ![Cloud](https://img.shields.io/badge/Cloud-AWS%20%7C%20Azure%20%7C%20GCP-blue)

## 🏗️ System Architecture

This project implements a fully decoupled, event-driven backend utilizing the "Two-Step S3 Dance" for edge ingestion, paired with a self-healing LLM fallback system.

### 1. Edge Ingestion (iOS Shortcuts -> AWS)
* **The S3 Presigned URL Pipeline:** To avoid API Gateway's 10MB payload limits and Base64 encoding corruption, the iOS native Share Sheet first pings a lightweight API Gateway to securely request an ephemeral S3 Presigned URL.
* **Direct Binary Upload:** The iOS device then pushes the raw `.jpg` binary directly into the `snaptrack-raw-receipts` S3 bucket, ensuring zero data corruption and massive scalability.

### 2. Multi-Cloud Processing (AWS Lambda)
* **Trigger:** The S3 `ObjectCreated:Put` event asynchronously triggers the main Node.js processing Lambda.
* **OCR Extraction:** The image URL is passed to **Azure Document Intelligence** to extract highly accurate receipt text.
* **AI Extraction & Formatting:** The text is passed to **Google Gemini 2.5 Flash**, operating under a strict system prompt to return a standardized JSON schema containing `calories`, `macros` (protein, carbs, fats), and `items`.

### 3. Self-Healing Multi-Model Failover
To ensure absolute reliability against third-party API throttling (e.g., `503 Service Unavailable`), the processing Lambda implements a dynamic failover protocol:
* If Google Gemini fails, the Lambda gracefully catches the error and instantly reroutes the payload to **Groq's Llama 3.1 8B** model.
* The system is capable of completely seamless recovery without the user ever experiencing a dropped request.

### 4. Data Storage & Event-Driven Alerts
* **DynamoDB:** The resulting nutritional JSON is saved to a serverless Amazon DynamoDB table.
* **Event Webhooks:** Post-save, the Lambda runs a lightweight `Scan` to aggregate the user's daily caloric intake. If the total exceeds the dynamic daily target (e.g., 2200 kcal), the Lambda fires an HTTP POST request to the **Telegram Bot API**, delivering a real-time push notification to the user's mobile device.

### 5. Frontend Analytics (React + Tailwind)
* A cyberpunk-themed, dark-mode React dashboard polls the DynamoDB table to display real-time nutritional extraction.
* Features a dynamic progress bar for daily caloric targets and an "Active Day" toggle to dynamically adjust baseline metabolic goals.

## 🛠️ Technology Stack

**Infrastructure & Cloud:**
* AWS Lambda (Node.js 20.x)
* Amazon S3 (Binary Storage)
* Amazon API Gateway
* Amazon DynamoDB (NoSQL)
* AWS IAM (Strict Least-Privilege Policies)

**Artificial Intelligence:**
* Microsoft Azure (Document Intelligence OCR)
* Google Gemini 2.5 Flash (Primary LLM)
* Meta Llama 3.1 8B via Groq (Failover LLM)

**Frontend:**
* React (Vite)
* Tailwind CSS
* Recharts

## 🚀 Key Engineering Challenges Solved
1. **The Base64 Trap:** Successfully engineered around API Gateway's inability to efficiently handle binary image files by utilizing S3 Presigned URLs for direct edge-to-storage ingestion.
2. **Third-Party API Deprecation/Downtime:** Implemented a robust `try/catch` LLM routing system to guarantee uptime even during major LLM provider outages.
3. **Event-Driven Push Notifications:** Bypassed the need for costly Apple Developer certificates by utilizing Telegram's Bot API as a secure, free webhook delivery system for push alerts.