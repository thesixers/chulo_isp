import axios from "axios";
import { v4 as uuidv4 } from "uuid";

const url = process.env.FLW_BASE_URL;

const secretKey = process.env.FLW_SECRET_KEY;

const flw = axios.create({
    baseURL: process.env.FLW_BASE_URL,
    headers: {
      Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
  });

const reqObject = {
  email: "nnamdiamaga2k20@gmail.com",
  currency: "NGN",
  tx_ref: uuidv4(),
  amount: 1000,
  narration: "Chulo Speednet Daily Plan",
  phonenumber: "08123456789",
  firstname: "Chulo",
  lastname: "Speednet",
  frequency: 1,
  is_permanent: false,
};

// const createDynamicVirtualAccount = async () => {
//   try {
//     const res = await fetch(url, {
//       body: JSON.stringify(reqObject),
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         Authorization: `Bearer ${secretKey}`,
//       },
//     });

//     const resJson = await res.json();
//     console.log(JSON.stringify(resJson, null, 2));
//   } catch (error) {
//     console.error("Error creating dynamic virtual account:", error);
//   }
// };

async function createDynamicVirtualAccount(phone, amount, planName) {
  const email = `ikedichimo@gmail.com`;
    const txRef = uuidv4();
    const chuloPhone = process.env.ADMIN_PHONE.split(",")[0].replace("234", "0") || "08112677404";
    const resOBJ = {
        email,
        is_permanent: false,
        tx_ref: txRef,
        amount,
        currency: "NGN",
        narration: `Chulo Speednet ${planName}`,
        phonenumber: chuloPhone,
        firstname: "Chulo",
        lastname: "Speednet",
        frequency: 1,
      }

      console.log("Request Object:", resOBJ);

    try {
      const response = await flw.post("/virtual-account-numbers", resOBJ);

      const data = response.data.data;

      console.log("Flutterwave Virtual Account Created:", response.data);
      return {
        txRef,
        accountNumber: data.account_number,
        accountName: `Chulo Speednet ${planName}`,
        bankName: data.bank_name,
      };
    } catch (error) {

      console.error(
        "Flutterwave Virtual Account Error:",
        error.response?.data || error.message,
      );
    }
}

// createDynamicVirtualAccount("08123456789", 1000, "Daily Plan");

export async function verifyPayment(txRef, amount) {
  try {
    const response = await flw.get("/transactions/verify_by_reference", {
      params: { tx_ref: txRef },
    });

    if(response.data.status === "success" && response.data.data.amount === amount && response.data.data.tx_ref === txRef) {
      console.log("Payment verified successfully.");
      return true;
    } else {
      console.log("Payment verification failed.");
      return false;
    }

    // return !!match;
  } catch (err) {
    console.error(
      "Flutterwave verification error:",
      err.response?.data || err.message
    );
    // On API/network error return false — never falsely confirm an unpaid transaction
    return false;
  }
}

verifyPayment("cc5dc086-af47-49dc-8f1f-6b5685eea38y", 1000)

