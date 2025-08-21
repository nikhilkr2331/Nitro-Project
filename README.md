📂 File Upload API
This API allows users to upload files, track upload progress, and retrieve uploaded files. It uses Node.js, Express, and MongoDB, with Multer for file handling.

✅ Features
✔ Upload files with multipart/form-data
✔ Track upload progress using an uploadId
✔ Store file metadata in MongoDB
✔ Download uploaded files
✔ Postman collection provided for testing

🔧 Setup Instructions
1. Clone the repository
git clone https://github.com/your-username/file-upload-api.git
cd file-upload-api

2. Install dependencies
npm install

3. Create .env file
PORT=3000
MONGODB_URI=mongodb://localhost:27017/fileUploadDB

4. Start MongoDB
mongod

5. Run the server
npm start

The API will be available at:
http://localhost:3000

📄 API Documentation
1. Generate Upload ID
Create a unique uploadId for tracking progress.

Endpoint:
POST /files/request-id

Response:
{
  "uploadId": "d3a5b9a0-5c8e-4f61-b26f-9c122cd4f7e2"
}

2. Upload a File
Upload a file with an optional uploadId.

Endpoint:
POST /files/upload

Headers:
Content-Type: multipart/form-data

Body (form-data):

file (File)

uploadId (String, optional)

Sample Response:

{
  "file_id": "66c8a0f4f8f1e457d4b1259c",
  "status": "uploading",
  "progress": 10,
  "uploadId": "d3a5b9a0-5c8e-4f61-b26f-9c122cd4f7e2"
}

3. Check Upload Progress
Check the progress of an upload using uploadId.

Endpoint:
GET /files/status/:uploadId

Sample Response (in-progress):
{
  "uploadId": "d3a5b9a0-...",
  "status": "uploading",
  "progress": 70
}

Sample Response (completed):
{
  "uploadId": "d3a5b9a0-...",
  "status": "completed",
  "progress": 100
}

4. Get File Metadata
Retrieve details of a file using its ID.

Endpoint:
GET /files/:fileId

Response:
{
  "_id": "66c8a0f4f8f1e457d4b1259c",
  "filename": "example.txt",
  "status": "completed",
  "uploadId": "d3a5b9a0-...",
  "createdAt": "2025-08-21T08:30:00.000Z"
}

5. Download File
Download an uploaded file.

Endpoint:
GET /files/download/:fileId

✅ Sample cURL Requests
Upload File

curl -X POST http://localhost:3000/files/upload \
-F "file=@sample.txt" \
-F "uploadId=d3a5b9a0-5c8e-4f61-b26f-9c122cd4f7e2"


Check Status
curl http://localhost:3000/files/status/d3a5b9a0-5c8e-4f61-b26f-9c122cd4f7e2


📥 Postman Collection
Create a file named postman_collection.json and add this content:

{
  "info": {
    "name": "File Upload API",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Generate Upload ID",
      "request": {
        "method": "POST",
        "url": "{{baseUrl}}/files/request-id"
      }
    },
    {
      "name": "Upload File",
      "request": {
        "method": "POST",
        "body": {
          "mode": "formdata",
          "formdata": [
            { "key": "file", "type": "file", "src": "" },
            { "key": "uploadId", "value": "", "type": "text" }
          ]
        },
        "url": "{{baseUrl}}/files/upload"
      }
    },
    {
      "name": "Check Upload Status",
      "request": {
        "method": "GET",
        "url": "{{baseUrl}}/files/status/:uploadId"
      }
    }
  ]
}


















































