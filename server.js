require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const admin = require('firebase-admin');
const { pcsLogin } = require('./pcs_login');

// ==========================================
// CONFIGURATION — lue depuis les variables d'environnement
// (configurées sur Render, jamais codées en dur ici)
// ==========================================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OCR_API_KEY = process.env.OCR_API_KEY;

// Le contenu du fichier firebase-service-account.json est collé
// tel quel dans la variable d'environnement FIREBASE_SERVICE_ACCOUNT
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
app.use(express.json());

// ==========================================
// 1. Vérification du webhook (Meta l'appelle une fois à la configuration)
// ==========================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('--- Tentative de vérification webhook ---');
  console.log('mode reçu :', mode);
  console.log('token reçu :', token);
  console.log('token attendu :', VERIFY_TOKEN);
  console.log('challenge reçu :', challenge);

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook vérifié avec succès');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Vérification échouée : mode ou token ne correspond pas');
    res.sendStatus(403);
  }
});

// ==========================================
// 2. Réception des messages WhatsApp
// ==========================================
app.post('/webhook', async (req, res) => {
  // On répond tout de suite à Meta pour ne pas timeout (le traitement continue en arrière-plan)
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return; // pas un message (accusé de lecture, etc.)

    if (message.type !== 'image') {
      console.log('Message reçu mais ce n\'est pas une image, ignoré.');
      return;
    }

    const nomExpediteur =
      value.contacts?.[0]?.profile?.name || 'Inconnu';
    const numeroExpediteur = message.from;
    const mediaId = message.image.id;

    console.log(`Image reçue de ${nomExpediteur} (${numeroExpediteur})`);

    // 1. Récupérer l'URL de téléchargement du média
    const infoMedia = await axios.get(
      `https://graph.facebook.com/v20.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } },
    );
    const urlMedia = infoMedia.data.url;

    // 2. Télécharger l'image (bytes)
    const reponseImage = await axios.get(urlMedia, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer',
    });
    const imageBytes = Buffer.from(reponseImage.data);

    // 3. Envoyer à l'OCR
    const texteOcr = await extraireTexteOcr(imageBytes);

    // 4. Parser Type / Montant / Code
    const type = detecterType(texteOcr);
    const montant = detecterMontant(texteOcr);
    const code = detecterCode(texteOcr);

    // 5. Sauvegarder dans Firestore
    await db.collection('historique').add({
      type,
      montant,
      code,
      nomExpediteur,
      numeroExpediteur,
      imageBase64: imageBytes.toString('base64'),
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Ticket enregistré : ${type} / ${montant} / ${code}`);

    // Si c'est un ticket PCS, on déclenche automatiquement la connexion
    if (type === 'PCS') {
      console.log('Ticket PCS détecté, déclenchement de la connexion automatique...');

      const resultatConnexion = await pcsLogin(
        process.env.PCS_USERNAME,
        process.env.PCS_PASSWORD,
      );

      console.log('Résultat de la connexion PCS automatique :', resultatConnexion);
    }
  } catch (erreur) {
    console.error('Erreur lors du traitement du message :', erreur.message);
  }
});

// ==========================================
// OCR — appel à OCR.space (même logique que ton service Flutter)
// ==========================================
async function extraireTexteOcr(imageBytes) {
  const form = new FormData();
  form.append('apikey', OCR_API_KEY);
  form.append('language', 'fre');
  form.append('isOverlayRequired', 'false');
  form.append('OCREngine', '2');
  form.append('file', imageBytes, { filename: 'image.jpg' });

  const reponse = await axios.post(
    'https://api.ocr.space/parse/image',
    form,
    { headers: form.getHeaders() },
  );

  if (reponse.data.IsErroredOnProcessing) {
    throw new Error(reponse.data.ErrorMessage || 'Erreur OCR');
  }

  return reponse.data.ParsedResults?.[0]?.ParsedText || '';
}

// ==========================================
// PARSING — même logique que ton ticket_parser.dart, adaptée en JS
// ==========================================
function detecterType(texte) {
  const texteMaj = texte.toUpperCase();

  if (texteMaj.includes('TRANSCASH')) return 'Transcash';
  if (texteMaj.includes('PCS')) return 'PCS';
  if (texteMaj.includes('NEO')) return 'NEO';
  if (/\bTC\b/.test(texteMaj)) return 'TC';

  return 'Inconnu';
}

function detecterMontant(texte) {
  let match = texte.match(
    /Prix\s+de\s+la\s+recharge\s*:?\s*(\d+[.,]?\d*)\s*(EUR|€)/i,
  );
  if (match) return `${match[1].replace(',', '.')}€`;

  match = texte.match(
    /Cr[ée]dit\s*:?\s*(\d+[.,]?\d*)\s*(Euros?|EUR|€)/i,
  );
  if (match) return `${match[1].replace(',', '.')}€`;

  match = texte.match(
    /Montant\s*:?\s*(\d+[.,]?\d*)\s*(Euros?|EUR|€)/i,
  );
  if (match) return `${match[1].replace(',', '.')}€`;

  const matches = [...texte.matchAll(/(\d+[.,]\d{1,2})\s*(EUR|€|Euros?)/gi)];
  let maxMontant = 0;
  let maxTexte = '-';

  for (const m of matches) {
    const valeur = parseFloat(m[1].replace(',', '.'));
    if (valeur > maxMontant) {
      maxMontant = valeur;
      maxTexte = `${m[1].replace(',', '.')}€`;
    }
  }

  return maxTexte;
}

function detecterCode(texte) {
  let match = texte.match(
    /code\s+recharge\s+est\s*[:\-]?\s*(\d{8,})/i,
  );
  if (match) return match[1];

  match = texte.match(
    /code\s+secret\s*:?\s*[\r\n]?\s*([A-Z0-9]{6,})/i,
  );
  if (match) return match[1].toUpperCase();

  match = texte.match(/\b\d{8,}\b/);
  if (match) return match[0];

  match = texte.toUpperCase().match(/\b[A-Z0-9]{8,}\b/);
  if (match) return match[0];

  return '-';
}

// ==========================================


app.post('/pcs-login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'username et password sont requis',
    });
  }

  console.log(`Tentative de connexion PCS pour l'utilisateur : ${username}`);

  const resultat = await pcsLogin(username, password);

  console.log('Résultat de la connexion PCS :', resultat);

  res.json(resultat);
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});