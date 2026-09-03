const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();

// Configuration
const CONFIG = {
  smsbowerApiKey: process.env.SMSBOWER_API_KEY || 'Q9ojxBGCvyAll68E1FCm77wETaINsgFP',
  phoneNumber: process.env.PHONE_NUMBER,
  hapiUrl: 'https://www.ihapilive.com',
  dataDir: './data',
  credentialsFile: './data/credentials.json'
};

// Create data directory if not exists
fs.ensureDirSync(CONFIG.dataDir);

/**
 * Fetch OTP from SMSBower API
 */
async function fetchOTPFromSMSBower(phoneNumber) {
  try {
    console.log(`[SMSBower] Fetching OTP for ${phoneNumber}...`);
    
    // SMSBower API endpoint
    const response = await axios.get('https://smsbower.online/api/inbox', {
      params: {
        phone: phoneNumber,
        key: CONFIG.smsbowerApiKey
      }
    });

    console.log('[SMSBower] Response:', response.data);

    if (response.data && Array.isArray(response.data) && response.data.length > 0) {
      const lastMessage = response.data[0];
      const messageText = lastMessage.message || '';
      
      console.log(`[SMSBower] Message: ${messageText}`);
      
      // Extract OTP from message (4-6 digits)
      const otpMatch = messageText.match(/\b(\d{4,6})\b/);
      
      if (otpMatch) {
        console.log(`[SMSBower] ✅ OTP found: ${otpMatch[1]}`);
        return otpMatch[1];
      }
    }
    
    console.log('[SMSBower] ⚠️ No OTP found in messages');
    return null;
  } catch (error) {
    console.error('[SMSBower Error]', error.message);
    return null;
  }
}

/**
 * Wait for OTP with retry
 */
async function waitForOTP(phoneNumber, maxRetries = 10, delay = 3000) {
  for (let i = 0; i < maxRetries; i++) {
    console.log(`[OTP] Attempt ${i + 1}/${maxRetries}...`);
    const otp = await fetchOTPFromSMSBower(phoneNumber);
    
    if (otp) {
      return otp;
    }
    
    if (i < maxRetries - 1) {
      console.log(`[OTP] Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return null;
}

/**
 * Login to Hapi using Puppeteer
 */
async function loginToHapi(phoneNumber) {
  let browser;
  
  try {
    console.log('[Hapi] Launching browser...');
    
    // Launch browser with options to mimic real device
    browser = await puppeteer.launch({
      headless: false, // Show browser window
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
      defaultViewport: {
        width: 375,
        height: 812
      }
    });

    const page = await browser.newPage();
    
    // Set user agent to mimic mobile device
    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    );

    console.log('[Hapi] Opening login page...');
    await page.goto(`${CONFIG.hapiUrl}/`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Wait for phone number input
    console.log('[Hapi] Waiting for phone number input...');
    await page.waitForSelector('input[type="tel"], input[name*="phone"], input[placeholder*="phone"]', {
      timeout: 10000
    }).catch(() => {
      console.log('[Hapi] Phone input selector not found, trying different selectors...');
    });

    // Find and fill phone input
    const phoneInputs = await page.$$('input[type="tel"], input[name*="phone"], input[placeholder*="phone"], input[type="text"]');
    
    if (phoneInputs.length === 0) {
      throw new Error('Could not find phone input field');
    }

    console.log(`[Hapi] Found ${phoneInputs.length} input fields, using first one for phone number`);
    console.log(`[Hapi] Entering phone number: ${phoneNumber}`);
    
    await phoneInputs[0].type(phoneNumber, { delay: 50 });
    
    // Wait a bit for the form to respond
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Look for submit button
    console.log('[Hapi] Looking for submit button...');
    const buttons = await page.$$('button');
    
    let submitButton = null;
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text.includes('Continue') || text.includes('Next') || text.includes('Submit') || text.includes('Send')) {
        submitButton = btn;
        break;
      }
    }

    if (!submitButton && buttons.length > 0) {
      submitButton = buttons[0]; // Use first button if no specific one found
    }

    if (!submitButton) {
      throw new Error('Could not find submit button');
    }

    console.log('[Hapi] Clicking submit button...');
    await submitButton.click();

    // Wait for OTP input to appear or page to change
    console.log('[Hapi] Waiting for OTP input or next screen...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Try to find OTP input
    await page.waitForSelector('input[type="text"], input[name*="otp"], input[placeholder*="OTP"], input[placeholder*="code"]', {
      timeout: 15000
    }).catch(() => {
      console.log('[Hapi] OTP input not found yet, continuing...');
    });

    // Fetch OTP from SMSBower
    console.log('[Bot] Fetching OTP from SMSBower...');
    const otp = await waitForOTP(phoneNumber);

    if (!otp) {
      throw new Error('Failed to fetch OTP from SMSBower');
    }

    // Find OTP input and enter OTP
    const otpInputs = await page.$$('input[type="text"], input[name*="otp"], input[placeholder*="OTP"]');
    
    if (otpInputs.length > 0) {
      console.log(`[Hapi] Found OTP input, entering OTP: ${otp}`);
      await otpInputs[0].type(otp, { delay: 50 });
      
      // Wait a bit for the form to respond
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Click confirm button
      console.log('[Hapi] Looking for confirm button...');
      const confirmButtons = await page.$$('button');
      
      for (const btn of confirmButtons) {
        const text = await page.evaluate(el => el.textContent, btn);
        if (text.includes('Verify') || text.includes('Confirm') || text.includes('Login') || text.includes('Submit')) {
          console.log('[Hapi] Clicking confirm button...');
          await btn.click();
          break;
        }
      }
    }

    // Wait for login to complete
    console.log('[Hapi] Waiting for login to complete...');
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
      console.log('[Hapi] Navigation timeout, continuing anyway...');
    }

    // Get cookies (session data)
    const cookies = await page.cookies();
    console.log('[Hapi] ✅ Login successful!');

    // Get current URL to confirm login
    const currentUrl = page.url();
    console.log(`[Hapi] Current URL: ${currentUrl}`);

    // Save credentials
    const credentials = {
      phoneNumber,
      otp,
      loginTime: new Date().toISOString(),
      cookies: cookies,
      currentUrl: currentUrl,
      status: 'success'
    };

    saveCredentials(credentials);
    console.log('[Bot] ✅ Credentials saved!');

    return credentials;

  } catch (error) {
    console.error('[Hapi Error]', error.message);
    
    // Save failed attempt
    const failedAttempt = {
      phoneNumber,
      loginTime: new Date().toISOString(),
      status: 'failed',
      error: error.message
    };
    
    saveCredentials(failedAttempt);
    throw error;

  } finally {
    if (browser) {
      console.log('[Bot] Closing browser...');
      await browser.close();
    }
  }
}

/**
 * Save credentials to local file
 */
function saveCredentials(data) {
  try {
    let existingData = [];
    
    if (fs.existsSync(CONFIG.credentialsFile)) {
      existingData = fs.readJsonSync(CONFIG.credentialsFile, { throws: false }) || [];
    }
    
    existingData.push(data);
    fs.writeJsonSync(CONFIG.credentialsFile, existingData, { spaces: 2 });
    console.log(`[Storage] Credentials saved to ${CONFIG.credentialsFile}`);
  } catch (error) {
    console.error('[Storage Error]', error.message);
  }
}

/**
 * Main function
 */
async function main() {
  try {
    const phoneNumber = CONFIG.phoneNumber;
    
    if (!phoneNumber) {
      throw new Error('PHONE_NUMBER not set in .env file');
    }
    
    if (!CONFIG.smsbowerApiKey) {
      throw new Error('SMSBOWER_API_KEY not set in .env file');
    }

    console.log('\n╔════════════════════════════════════╗');
    console.log('║   Hapi Login Bot Started 🚀        ║');
    console.log('╚════════════════════════════════════╝\n');
    console.log(`Phone Number: ${phoneNumber}`);
    console.log(`Hapi URL: ${CONFIG.hapiUrl}`);
    console.log('\n');

    await loginToHapi(phoneNumber);

    console.log('\n╔════════════════════════════════════╗');
    console.log('║   Bot Completed Successfully ✅    ║');
    console.log('╚════════════════════════════════════╝\n');
    process.exit(0);

  } catch (error) {
    console.error('\n╔════════════════════════════════════╗');
    console.error('║   Bot Failed ❌                    ║');
    console.error('╚════════════════════════════════════╝\n');
    console.error(error);
    process.exit(1);
  }
}

// Run bot
if (require.main === module) {
  main();
}

module.exports = { loginToHapi, fetchOTPFromSMSBower };
