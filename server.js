require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');

const app = express();
app.use(express.json());
app.use(cors()); 

const upload = multer({ dest: 'uploads/' });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

app.post('/api/admin/archivos', upload.single('documento'), async (req, res) => {
    try {
        console.log("📥 Recibiendo nuevo PDF...");
        const filePath = req.file.path;
        const uploadResponse = await fileManager.uploadFile(filePath, {
            mimeType: "application/pdf",
            displayName: req.file.originalname,
        });
        fs.unlinkSync(filePath); 
        console.log("✅ PDF subido a Gemini con ID:", uploadResponse.file.name);
        res.json({ mensaje: 'Archivo subido', file_id: uploadResponse.file.name });
    } catch (error) {
        console.error("❌ ERROR AL SUBIR PDF:", error);
        res.status(500).json({ error: 'Error al subir el documento.' });
    }
});

app.get('/api/admin/archivos', async (req, res) => {
    try {
        const listFilesResponse = await fileManager.listFiles();
        const archivos = (listFilesResponse.files || []).map(f => ({
            id: f.name,
            nombre: f.displayName,
            fecha: new Date(f.createTime).toLocaleDateString()
        }));
        res.json(archivos);
    } catch (error) {
        res.status(500).json({ error: 'Error al listar los documentos.' });
    }
});

// Ruta corregida para borrar archivos de Gemini
app.delete('/api/admin/archivos/files/:fileId', async (req, res) => {
    try {
        const fileId = `files/${req.params.fileId}`;
        console.log("🗑️ Eliminando archivo de Gemini:", fileId);
        await fileManager.deleteFile(fileId);
        console.log("✅ Archivo eliminado con éxito");
        res.json({ mensaje: 'Archivo eliminado' });
    } catch (error) {
        console.error("❌ Error al eliminar archivo:", error);
        res.status(500).json({ error: 'Error al eliminar el documento.' });
    }
});

app.delete('/api/admin/archivos/:fileId', async (req, res) => {
    try {
        const fileId = req.params.fileId.startsWith('files/') 
            ? req.params.fileId 
            : `files/${req.params.fileId}`;
        console.log("🗑️ Eliminando archivo de Gemini:", fileId);
        await fileManager.deleteFile(fileId);
        console.log("✅ Archivo eliminado con éxito");
        res.json({ mensaje: 'Archivo eliminado' });
    } catch (error) {
        console.error("❌ Error al eliminar archivo:", error);
        res.status(500).json({ error: 'Error al eliminar el documento.' });
    }
});

// --- RUTA DEL CHATBOT ---
app.post('/api/chat', async (req, res) => {
    try {
        const { pregunta } = req.body;
        console.log("🗣️ El usuario preguntó:", pregunta);

        const listFilesResponse = await fileManager.listFiles();
        const archivosActivos = listFilesResponse.files || [];

        if (archivosActivos.length === 0) {
            console.log("⚠️ No hay archivos en la cuenta de Gemini.");
            return res.json({ respuesta: "No hay PDFs subidos para leer." });
        }

        console.log(`📚 Preparando ${archivosActivos.length} archivo(s) para leer...`);
        const contextoArchivos = archivosActivos.map(f => ({
            fileData: { mimeType: f.mimeType, fileUri: f.uri }
        }));

        const model = genAI.getGenerativeModel({
            model: "gemini-3.6-flash",
            systemInstruction: "Responde basándote ÚNICAMENTE en los documentos proporcionados. Si la respuesta no está, di que no sabes."
        });

        console.log("🧠 Enviando pregunta a Gemini...");
        const result = await model.generateContent([...contextoArchivos, pregunta]);
        
        console.log("✅ Gemini respondió con éxito.");
        res.json({ respuesta: result.response.text() });

    } catch (error) {
        console.error("🚨 ERROR FATAL DE GEMINI:", error);
        res.status(500).json({ error: 'Error procesando tu pregunta.' });
    }
});

app.listen(3000, () => {
    console.log(`🚀 Motor funcionando! Escuchando en el puerto 3000`);
});
