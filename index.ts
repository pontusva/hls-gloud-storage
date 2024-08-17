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
// import { __dirname, __filename } from "./config";

init;
// ffmpeg.setFfmpegPath(
//   "C:/Users/hyperslap/Downloads/ffmpeg-master-latest-win64-gpl/ffmpeg-master-latest-win64-gpl/bin/ffmpeg"
// );
const app = express();
app.use(cors());
app.use(express.json());
const port = 3000;

app.post("/api/request-audio", async (req, res) => {
  const { fileName } = req.body;
  if (!fileName) {
    return res.status(400).json({ error: "fileName is required" });
  }
  try {
    // Generate a unique token and directory name
    const token = crypto.randomBytes(16).toString("hex");
    const uniqueDirName = uuidv4(); // This will be used as the folder name
    const dynamicDirPath = path.join(__dirname, "hls_output", uniqueDirName);

    // Create the unique directory once
    await fs.ensureDir(dynamicDirPath);

    // Define paths for the audio file and HLS output within this directory
    const localFilePath = path.join(dynamicDirPath, fileName);
    const hlsFileName = `${token}.m3u8`;
    const hlsFilePath = path.join(dynamicDirPath, hlsFileName);

    console.log("Expected HLS file path:", hlsFilePath);

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
        // Conversion and upload logic
        await new Promise<void>((resolve, reject) => {
          ffmpeg(localFilePath)
            .outputOptions([
              "-start_number 0",
              "-hls_time 10",
              "-hls_list_size 0",
              "-f hls",
            ])
            .output(hlsFilePath)
            .on("end", async () => {
              console.log("HLS conversion finished.");

              // Remove the original file after conversion
              await fs.remove(localFilePath);
              console.log("Original file removed after conversion.");

              resolve();
            })
            .on("error", (err) => {
              console.error("Error during conversion:", err);
              reject(err);
            })
            .run();
        });

        // Upload files and send the response only after all processes finish
        await uploadFolderToCloudStorage(
          getStorage().bucket(process.env.BUCKET_NAME),
          dynamicDirPath,
          uniqueDirName
        );
        res.json({
          hlsUrl: `${uniqueDirName}/${hlsFileName}`,
        });

        // Cleanup: remove the entire directory
        await fs.remove(dynamicDirPath);
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
      console.log(`Skipping directory: ${localFilePath}`);
      continue;
    }

    const cloudFilePath = normalizePath(`${folderId}/${file}`);
    console.log(
      `Uploading file: ${localFilePath} to cloud path: ${cloudFilePath}`
    );
    const cloudFile = bucket.file(cloudFilePath);

    try {
      const [uploadUrl] = await cloudFile.createResumableUpload();

      await new Promise<void>((resolve, reject) => {
        const fileStream = fs.createReadStream(localFilePath);

        fileStream.on("error", (err) => {
          console.error(`Stream error for file: ${localFilePath}`, err);
          reject(err);
        });

        axios({
          method: "PUT",
          url: uploadUrl,
          headers: {
            "Content-Type": "application/octet-stream",
          },
          data: fileStream,
        })
          .then(() => {
            console.log(`Successfully uploaded: ${localFilePath}`);
            resolve();
          })
          .catch((error) => {
            console.error(
              `Error during file upload for: ${localFilePath}`,
              error
            );
            reject(error);
          });
      });

      const [fileUrl] = await cloudFile.getSignedUrl({
        action: "read",
        expires: "03-09-2491",
      });

      console.log(`File uploaded and accessible at: ${fileUrl}`);
      uploadedFiles.push({ fileName: file, url: fileUrl });
    } catch (error) {
      console.error(`Error uploading ${file} to cloud storage:`, error);
    }
  }

  return uploadedFiles;
}

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
