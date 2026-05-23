import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const flw = axios.create({
    baseURL: process.env.FLW_BASE_URL,
    headers: {
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
        'Content-Type': 'application/json',
    },
});

const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_ATTEMPTS  = 3;
const RETRY_DELAY_MS  = 5000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));


/**
 * Creates a dynamic (temporary) virtual account for a specific transaction.
 * Uses the Flutterwave v3 API — no separate customer creation needed.
 *
 * Automatically retries up to 3 times on 502/503/504 (gateway errors).
 *
 * @param {string} phone     - User's phone number
 * @param {number} amount    - Exact plan price the customer must pay
 * @param {string} planName  - Plan name for narration (e.g. "Daily Plan")
 * @returns {Promise<{ txRef: string, accountNumber: string, bankName: string }>}
 */
export async function createDynamicVirtualAccount(phone, amount, planName) {
    const txRef = uuidv4(); // generated once — consistent across retries
    const email = `${phone}@chuloisp.local`;

    let lastError;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        try {
            const response = await flw.post('/virtual-account-numbers', {
                email,
                is_permanent: false,
                tx_ref: txRef,
                amount,
                currency: 'NGN',
                narration: `Chulo ISP - ${planName}`,
                phonenumber: phone,
                firstname: 'Chulo',
                lastname: 'User',
                frequency: 1,   // single-use: expires after one successful payment
            });

            const data = response.data.data;
            return {
                txRef,
                accountNumber: data.account_number,
                bankName: data.bank_name,
            };
        } catch (error) {
            const status = error.response?.status;
            lastError = error;

            if (RETRY_STATUSES.has(status) && attempt < RETRY_ATTEMPTS) {
                console.warn(`Flutterwave ${status} on attempt ${attempt}/${RETRY_ATTEMPTS} — retrying in ${RETRY_DELAY_MS / 1000}s...`);
                await sleep(RETRY_DELAY_MS);
                continue;
            }

            console.error('Flutterwave Virtual Account Error:', error.response?.data || error.message);
            break;
        }
    }
    throw lastError;
}
