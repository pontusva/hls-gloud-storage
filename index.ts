import { getStorage } from "firebase-admin/storage";
import express from "express";
import { init } from "./initAuth";
import axios from "axios";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import fs from "fs-extra";
import ffmpeg from "fluent-ffmpeg";
import { v4 as uuidv4 } from "uuid";
init;
ffmpeg.setFfmpegPath(
  "C:/Users/hyperslap/Downloads/ffmpeg-master-latest-win64-gpl/ffmpeg-master-latest-win64-gpl/bin/ffmpeg"
);
const app = express();
app.use(cors());
app.use(express.json());
const port = 3000;

const outputDir = path.join(__dirname, "hls_output");
// POST endpoint to receive file name and return a streaming URL or token

app.post("/api/request-audio", async (req, res) => {
  const { fileName } = req.body;
  try {
    // Generate a unique token and directory name
    const token = crypto.randomBytes(16).toString("hex");
    const uniqueDirName = uuidv4(); // This will be used as the folder name
    const dynamicDirPath = path.join(__dirname, "hls_output", uniqueDirName);

    // Create the unique directory once
    await fs.ensureDir(dynamicDirPath);

    // Define paths for the audio file and HLS output within this directory
    const localFilePath = path.join(dynamicDirPath, "temp_audio.mp3");
    const hlsFileName = `${token}.m3u8`;
    const hlsFilePath = path.join(dynamicDirPath, hlsFileName);

    // Get the signed URL for the file
    const fileRef = await getStorage()
      .bucket(process.env.BUCKET_NAME)
      .file(fileName)
      .getSignedUrl({
        action: "read",
        expires: "03-09-2491",
      });

    const audioUrl = fileRef[0];

    // Download the audio file locally into the dynamic directory
    const response = await axios({
      url: audioUrl,
      method: "GET",
      responseType: "stream",
    });

    // Create a writable stream for the downloaded file
    const fileStream = fs.createWriteStream(localFilePath);
    response.data.pipe(fileStream);

    // Wait for the download to finish before proceeding
    fileStream.on("finish", async () => {
      try {
        // Convert the downloaded MP3 to HLS format
        await new Promise<void>((resolve, reject) => {
          ffmpeg(localFilePath)
            .outputOptions([
              "-start_number 0",
              "-hls_time 10",
              "-hls_list_size 0",
              "-f hls",
            ])
            .output(hlsFilePath)
            .on("end", () => {
              console.log("HLS conversion finished.");
              resolve();
            })
            .on("error", (err) => {
              console.error("Error during conversion:", err);
              reject(err);
            })
            .run();
        });

        await fs.remove(localFilePath);
        // Upload files to cloud storage
        await uploadFolderToCloudStorage(
          getStorage().bucket(process.env.BUCKET_NAME), // Correct bucket reference
          dynamicDirPath, // Local directory where files are stored
          uniqueDirName // Unique folder name
        );

        // Return the HLS URL to the frontend
        res.json({
          hlsUrl: `${uniqueDirName}/${hlsFileName}`, // Use the dynamic directory in the URL
        });

        // Cleanup: Remove the entire dynamic directory after files are uploaded

        await fs.remove(dynamicDirPath);
        console.log("Local directory removed successfully");
      } catch (err) {
        console.error("Error processing files:", err);
        res.status(500).send("Error during processing");
      }
    });

    // Handle errors during the download
    fileStream.on("error", (err) => {
      console.error("Error writing file:", err);
      res.status(500).send("Error downloading file");
    });
  } catch (error) {
    console.error("Error processing request:", error);
    res.status(500).send("Internal server error");
  }
});

// Function to normalize paths (convert backslashes to forward slashes)
const normalizePath = (p) => p.replace(/\\/g, "/");

// Function to upload files from a directory to cloud storage
async function uploadFolderToCloudStorage(bucket, localDirPath, folderId) {
  console.log(
    `Starting upload from local directory: ${localDirPath} to folder ID: ${folderId}`
  );

  const files = await fs.readdir(localDirPath);
  const uploadedFiles: { fileName: string; url: any }[] = [];

  for (const file of files) {
    const localFilePath = path.join(localDirPath, file);
    const stat = await fs.stat(localFilePath);

    if (stat.isDirectory()) {
      // Skip directories
      console.log(`Skipping directory: ${localFilePath}`);
      continue;
    }

    // Construct the cloud file path directly under the specified folderId
    const cloudFilePath = normalizePath(`${folderId}/${file}`);
    console.log(
      `Uploading file: ${localFilePath} to cloud path: ${cloudFilePath}`
    );
    const cloudFile = bucket.file(cloudFilePath);

    try {
      // Create a resumable upload session
      const [uploadUrl] = await cloudFile.createResumableUpload();

      // Stream the file to the upload URL
      await new Promise<void>((resolve, reject) => {
        const fileStream = fs.createReadStream(localFilePath);
        axios({
          method: "PUT",
          url: uploadUrl,
          headers: {
            "Content-Type": "application/octet-stream",
          },
          data: fileStream,
        })
          .then(() => resolve())
          .catch((error) => reject(error));
      });

      // Get a signed URL for the uploaded file
      const [fileUrl] = await cloudFile.getSignedUrl({
        action: "read",
        expires: "03-09-2491",
      });

      uploadedFiles.push({ fileName: file, url: fileUrl });
    } catch (error) {
      console.error(`Error uploading ${file} to cloud storage:`, error);
    }
  }

  return uploadedFiles;
}

// GET endpoint to stream the audio file using the token or file name
app.get("/api/stream-audio/:filename", async (req, res) => {
  const { filename } = req.params;

  // Construct file path
  const filePath = path.join(outputDir, filename);

  console.log(`Requested file path: ${filePath}`);

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return res.status(404).send("File not found");
  }

  // Set appropriate content type based on the file extension
  const extname = path.extname(filePath).toLowerCase();
  const contentType =
    extname === ".m3u8"
      ? "application/vnd.apple.mpegurl"
      : extname === ".ts"
      ? "audio/mpeg"
      : "application/octet-stream";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");

  // Stream the file
  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
