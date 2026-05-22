import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const flw = axios.create({
    baseURL: process.env.FLW_BASE_URL,
    headers: {
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
        'Content-Type': 'application/json',
    },
});

/**
 * Creates a dynamic (temporary) virtual account for a specific transaction.
 * Uses the Flutterwave v3 API — no separate customer creation needed.
 *
 * Dynamic accounts expire after `expiryMinutes` and are tied to an exact amount.
 * BVN is NOT required for dynamic/temporary accounts.
 *
 * @param {string} phone            - User's phone number
 * @param {number} amount           - Exact plan price the customer must pay
 * @param {string} planName         - Plan name for narration (e.g. "Daily Plan")
 * @param {number} expiryMinutes    - How long the account stays active (default: 60 min)
 * @returns {Promise<{ txRef: string, accountNumber: string, bankName: string }>}
 */
export async function createDynamicVirtualAccount(phone, amount, planName) {
    const txRef = uuidv4(); // this is stored in payments table for webhook lookup
    const email = `${phone}@chuloisp.local`;

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
            txRef,                              // stored in payments.virtual_account_reference
            accountNumber: data.account_number,
            bankName: data.bank_name,
        };
    } catch (error) {
        console.error('Flutterwave v3 Virtual Account Error:', error.response?.data || error.message);
        throw error;
    }
}
