const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const pdf = require('pdf-parse');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Iniciar Gemini (Asegúrate de tener GEMINI_API_KEY en los Environment Variables de Render)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }); 
const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-001' });

const upload = multer({ dest: 'uploads/' });

// --- 🧠 BASE DE DATOS VECTORIAL (EN MEMORIA) ---
let documentosActivos = []; // Para mostrar en tu Panel Admin web
let baseDeDatosVectorial = []; // Aquí se guardan los fragmentos y sus coordenadas matemáticas

// --- ⚙️ HERRAMIENTAS RAG ---
// Función para picar el documento en bloques de ~1000 caracteres
function fragmentarTexto(texto, tamaño = 1000) {
    const fragmentos = [];
    let inicio = 0;
    while (inicio < texto.length) {
        let fin = inicio + tamaño;
        // Evita cortar palabras a la mitad buscando el próximo espacio
        if (fin < texto.length) {
            let proximoEspacio = texto.indexOf(' ', fin);
            if (proximoEspacio !== -1 && proximoEspacio - fin < 100) fin = proximoEspacio;
        }
        fragmentos.push(texto.slice(inicio, fin));
        inicio = fin;
    }
    return fragmentos;
}

// Función matemática para buscar los bloques más parecidos a la pregunta
function similitudCoseno(vecA, vecB) {
    let productoPunto = 0, normaA = 0, normaB = 0;
    for (let i = 0; i < vecA.length; i++) {
        productoPunto += vecA[i] * vecB[i];
        normaA += vecA[i] * vecA[i];
        normaB += vecB[i] * vecB[i];
    }
    return productoPunto / (Math.sqrt(normaA) * Math.sqrt(normaB));
}

// --- 🌐 RUTAS DEL SERVIDOR ---

// 1. Subir PDF, Picar y Vectorizar
app.post('/api/admin/archivos', upload.single('documento'), async (req, res) => {
    try {
        const file = req.file;
        const docId = file.filename;
        
        console.log(`📚 Leyendo PDF: "${file.originalname}"...`);
        const dataBuffer = fs.readFileSync(file.path);
        const data = await pdf(dataBuffer);
        const textoCompleto = data.text;
        
        const fragmentos = fragmentarTexto(textoCompleto);
        console.log(`🔪 Documento dividido en ${fragmentos.length} fragmentos. Generando vectores... (Esto puede tomar unos segundos)`);

        // Convertir cada fragmento en un vector usando Gemini Embeddings
        for (let i = 0; i < fragmentos.length; i++) {
            const text = fragmentos[i];
            // Evitamos enviar fragmentos vacíos
            if (text.trim().length > 10) { 
                const result = await embeddingModel.embedContent(text);
                const vector = result.embedding.values;
                
                baseDeDatosVectorial.push({
                    idDoc: docId,
                    texto: text,
                    vector: vector
                });
            }
        }

        documentosActivos.push({ id: docId, nombre: file.originalname });
        fs.unlinkSync(file.path); // Borramos el PDF físico para ahorrar espacio
        
        console.log("✅ ¡Documento vectorizado e indexado con éxito!");
        res.json({ mensaje: 'Archivo subido y procesado' });
    } catch (error) {
        console.error("❌ Error al procesar PDF:", error);
        res.status(500).json({ error: 'Error interno al procesar el documento' });
    }
});

// 2. Listar archivos (Para la Vista Admin)
app.get('/api/admin/archivos', (req, res) => {
    res.json(documentosActivos);
});

// 3. Borrar archivos
app.delete('/api/admin/archivos/:id', (req, res) => {
    const id = req.params.id;
    documentosActivos = documentosActivos.filter(d => d.id !== id);
    baseDeDatosVectorial = baseDeDatosVectorial.filter(v => v.idDoc !== id);
    console.log(`🗑️ Archivo eliminado de la base vectorial.`);
    res.json({ mensaje: 'Eliminado' });
});

// 4. El Chat Inteligente (Búsqueda + Respuesta)
app.post('/api/chat', async (req, res) => {
    try {
        const pregunta = req.body.pregunta;
        
        if (baseDeDatosVectorial.length === 0) {
            return res.json({ respuesta: "La base de datos está vacía. Por favor, sube un documento primero." });
        }

        console.log(`🗣️ Pregunta: ${pregunta}`);

        // Paso A: Convertir la pregunta a números
        const reqEmbedding = await embeddingModel.embedContent(pregunta);
        const vectorPregunta = reqEmbedding.embedding.values;

        // Paso B: Comparar la pregunta con todos los fragmentos del libro
        const resultados = baseDeDatosVectorial.map(item => {
            return {
                texto: item.texto,
                similitud: similitudCoseno(vectorPregunta, item.vector)
            };
        });

        // Paso C: Ordenar y elegir SOLO los 4 fragmentos más relevantes
        resultados.sort((a, b) => b.similitud - a.similitud);
        const mejoresFragmentos = resultados.slice(0, 4).map(r => r.texto);
        const contextoStr = mejoresFragmentos.join("\n\n---\n\n");
        
        console.log("🧠 Enviando solo los 4 fragmentos más útiles a Gemini...");

        // Paso D: Inyectar esos fragmentos en la orden a Gemini
        const promptFinal = `Eres un asistente experto. Responde a la pregunta del usuario basándote ÚNICAMENTE en la siguiente información extraída del documento. Si la respuesta no está en el texto proporcionado, di que no lo sabes, no inventes información.\n\nINFORMACIÓN EXTRAÍDA:\n${contextoStr}\n\nPREGUNTA DEL USUARIO: ${pregunta}`;

        const result = await model.generateContent(promptFinal);
        const respuesta = result.response.text();

        console.log("✅ Respuesta enviada al usuario");
        res.json({ respuesta: respuesta });
    } catch (error) {
        console.error("❌ Error en chat:", error);
        res.status(500).json({ error: 'Error al generar respuesta' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Motor RAG Vectorial funcionando en puerto ${PORT}`);
});
