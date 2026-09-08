const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Iniciar Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
const embeddingModel = genAI.getGenerativeModel({ model: 'embedding-001' }); // Usamos el modelo seguro que no da error 404

// --- 🧠 BASE DE DATOS VECTORIAL (EN MEMORIA) ---
let baseDeDatosVectorial = [];
let botListo = false; // Este interruptor nos dirá si el bot ya terminó de estudiar

// --- ⚙️ HERRAMIENTAS RAG ---
function fragmentarTexto(texto, tamaño = 1000) {
    const fragmentos = [];
    let inicio = 0;
    while (inicio < texto.length) {
        let fin = inicio + tamaño;
        if (fin < texto.length) {
            let proximoEspacio = texto.indexOf(' ', fin);
            if (proximoEspacio !== -1 && proximoEspacio - fin < 100) fin = proximoEspacio;
        }
        fragmentos.push(texto.slice(inicio, fin));
        inicio = fin;
    }
    return fragmentos;
}

function similitudCoseno(vecA, vecB) {
    let productoPunto = 0, normaA = 0, normaB = 0;
    for (let i = 0; i < vecA.length; i++) {
        productoPunto += vecA[i] * vecB[i];
        normaA += vecA[i] * vecA[i];
        normaB += vecB[i] * vecB[i];
    }
    return productoPunto / (Math.sqrt(normaA) * Math.sqrt(normaB));
}

// Función para obligar al bot a hacer pausas
const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 📚 RUTINA DE ESTUDIO (Se ejecuta sola al prender el servidor) ---
async function inicializarConocimiento() {
    console.log("Iniciando rutina de estudio...");
    const directorioPdfs = path.join(__dirname, 'pdfs');
    
    if (!fs.existsSync(directorioPdfs)) {
        console.log("No se encontró la carpeta 'pdfs'.");
        return;
    }

    const archivos = fs.readdirSync(directorioPdfs).filter(f => f.endsWith('.pdf'));
    
    if (archivos.length === 0) {
        console.log("No hay PDFs en la carpeta para leer.");
        return;
    }

    for (const archivo of archivos) {
        console.log(`\n📚 Leyendo: "${archivo}"...`);
        const dataBuffer = fs.readFileSync(path.join(directorioPdfs, archivo));
        const data = await pdf(dataBuffer);
        
        const fragmentos = fragmentarTexto(data.text);
        console.log(`🔪 Dividido en ${fragmentos.length} fragmentos. Memorizando... (Esto toma un momento)`);

        for (let i = 0; i < fragmentos.length; i++) {
            const text = fragmentos[i].trim();
            if (text.length > 10) {
                let exito = false;
                while (!exito) {
                    try {
                        const result = await embeddingModel.embedContent(text);
                        baseDeDatosVectorial.push({
                            fuente: archivo,
                            texto: text,
                            vector: result.embedding.values
                        });
                                                exito = true;
                        await esperar(4500); // Espera 4.5 segundos para no superar las 15 peticiones por minuto
                    } catch (error) {
                        console.log(`⚠️ Límite de velocidad detectado. Respirando 30 segundos...`);
                        await esperar(30000); // Si Google nos frena, hacemos una pausa larga
                    }

                }
            }
        }
        console.log(`✅ Documento "${archivo}" completamente memorizado.`);
    }
    
    botListo = true;
    console.log("\n🎓 ¡EL BOT HA TERMINADO DE ESTUDIAR Y ESTÁ LISTO PARA RESPONDER!");
}

// --- 🌐 RUTAS DEL SERVIDOR ---

// El Chat Inteligente
app.post('/api/chat', async (req, res) => {
    try {
        // Si el usuario pregunta mientras el bot lee, le avisamos:
        if (!botListo) {
            return res.json({ respuesta: "⏳ Aguarda un momento, me acaban de encender y todavía estoy leyendo los PDFs. ¡Intenta de nuevo en un minuto!" });
        }

        const pregunta = req.body.pregunta;
        console.log(`🗣️ Pregunta: ${pregunta}`);

        // Vectorizar pregunta y buscar
        const reqEmbedding = await embeddingModel.embedContent(pregunta);
        const vectorPregunta = reqEmbedding.embedding.values;

        const resultados = baseDeDatosVectorial.map(item => {
            return {
                texto: item.texto,
                similitud: similitudCoseno(vectorPregunta, item.vector)
            };
        });

        // Seleccionar los 4 mejores fragmentos
        resultados.sort((a, b) => b.similitud - a.similitud);
        const mejoresFragmentos = resultados.slice(0, 4).map(r => r.texto);
        const contextoStr = mejoresFragmentos.join("\n\n---\n\n");
        
        // Consultar a Gemini
        const promptFinal = `Eres un asistente experto. Responde a la pregunta basándote ÚNICAMENTE en la siguiente información.\n\nINFORMACIÓN EXTRAÍDA:\n${contextoStr}\n\nPREGUNTA DEL USUARIO: ${pregunta}`;

        const result = await model.generateContent(promptFinal);
        const respuesta = result.response.text();

        res.json({ respuesta: respuesta });
    } catch (error) {
        console.error("❌ Error en chat:", error);
        res.status(500).json({ error: 'Error al generar respuesta' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor encendido en puerto ${PORT}`);
    inicializarConocimiento(); // Inicia la lectura automática apenas prende
});
