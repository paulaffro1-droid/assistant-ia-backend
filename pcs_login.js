const sharp = require('sharp');
const chromium = require('@sparticuz/chromium');
const { createWorker, PSM } = require('tesseract.js');

// Sur Render (Linux), on utilise puppeteer-core + chromium précompilé.
// En local sur Windows, on utilise le puppeteer complet (avec son propre Chrome).
const estSurRender = process.platform === 'linux';
const puppeteer = estSurRender
  ? require('puppeteer-core')
  : require('puppeteer');

let workerPartage = null;

async function getWorker() {
  if (!workerPartage) {
    workerPartage = await createWorker('eng');
    await workerPartage.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    });
  }
  return workerPartage;
}

/**
 * Se connecte automatiquement sur mypcs.com.
 * Retourne success/message, ET une capture d'écran en base64 de la
 * page finale (preuve visuelle, à afficher dans l'app Flutter).
 */
async function pcsLogin(username, password) {
  let browser;

  try {
    const optionsLancement = estSurRender
      ? {
          args: chromium.args,
          defaultViewport: chromium.defaultViewport,
          executablePath: await chromium.executablePath(),
          headless: chromium.headless,
        }
      : {
          headless: 'new',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
          ],
        };

    browser = await puppeteer.launch(optionsLancement);

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto('https://account.mypcs.com/fr/login', {
      waitUntil: 'networkidle2',
    });

    await page.waitForSelector('#LoginUserUsername', { visible: true });
    await page.type('#LoginUserUsername', username, { delay: 50 });

    await page.click('.btn-login-username');

    await page.waitForSelector('.grid-keyboard', { visible: true });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const keyboardElement = await page.$('.grid-keyboard');
    const screenshotBrut = await keyboardElement.screenshot();
    const keyboardBox = await keyboardElement.boundingBox();

    const boutons = await page.$$eval('.grid-keyboard a', (elements) =>
      elements.map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          position: el.getAttribute('data-l'),
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        };
      }),
    );

    const mappingChiffreVersPosition = await lireChiffresCaseParCase(
      screenshotBrut,
      boutons,
      keyboardBox,
    );

    console.log('Mapping chiffre -> position :', mappingChiffreVersPosition);

    for (const chiffre of password.split('')) {
      const position = mappingChiffreVersPosition[chiffre];

      if (!position) {
        throw new Error(
          `Impossible de localiser le chiffre "${chiffre}" sur le clavier`,
        );
      }

      const bouton = boutons.find((b) => b.position === position);

      await page.mouse.click(
        bouton.x + bouton.width / 2,
        bouton.y + bouton.height / 2,
      );

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await page.waitForSelector('#login-submit:not([disabled])', {
      timeout: 5000,
    });
    await page.click('#login-submit');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });

    const urlFinale = page.url();
    const connexionReussie = !urlFinale.includes('/login');

    // Capture la page finale comme preuve visuelle
    const screenshotFinal = await page.screenshot({ encoding: 'base64' });

    console.log('Connexion terminée :', connexionReussie ? 'réussie' : 'échouée');

    return {
      success: connexionReussie,
      message: connexionReussie
        ? 'Connexion réussie'
        : 'Connexion échouée (identifiants incorrects ou blocage du site)',
      screenshotBase64: screenshotFinal,
    };
  } catch (erreur) {
    return {
      success: false,
      message: `Erreur lors de la connexion : ${erreur.message}`,
      screenshotBase64: null,
    };
  } finally {
    if (browser) await browser.close();
  }
}

async function lireChiffresCaseParCase(screenshotBrut, boutons, keyboardBox) {
  const image = sharp(screenshotBrut);
  const metadata = await image.metadata();

  const mapping = {};
  const marge = 6;

  const worker = await getWorker();

  for (const bouton of boutons) {
    let left = Math.round(bouton.x - keyboardBox.x - marge);
    let top = Math.round(bouton.y - keyboardBox.y - marge);
    let width = Math.round(bouton.width + marge * 2);
    let height = Math.round(bouton.height + marge * 2);

    left = Math.max(0, left);
    top = Math.max(0, top);
    width = Math.min(width, metadata.width - left);
    height = Math.min(height, metadata.height - top);

    const decoupe = await sharp(screenshotBrut)
      .extract({ left, top, width, height })
      .resize({ width: 400 })
      .greyscale()
      .linear(1.3, -30)
      .toBuffer();

    const {
      data: { text },
    } = await worker.recognize(decoupe);

    const match = text.match(/\d/);
    const chiffreLu = match ? match[0] : null;

    console.log(`Case ${bouton.position} -> chiffre lu : "${chiffreLu}"`);

    if (chiffreLu) {
      mapping[chiffreLu] = bouton.position;
    }
  }

  return mapping;
}

module.exports = { pcsLogin };
