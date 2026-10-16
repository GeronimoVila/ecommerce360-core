import axios from 'axios';

export const triggerB2CRevalidation = async (tag: string): Promise<void> => {
  try {
    const baseUrl = process.env.FRONTEND_B2C_URL;
    const secret = process.env.REVALIDATION_SECRET;

    if (!baseUrl || !secret) {
      console.error('[RevalidateUtil] ERROR CRÍTICO: Faltan variables de entorno FRONTEND_B2C_URL o REVALIDATION_SECRET.');
      return;
    }

    const targetUrl = `${baseUrl}/api/revalidate?tag=${tag}&secret=${secret}`;
    
    axios.post(targetUrl, {}, { timeout: 3000 }).catch((err: any) => {
      console.error('[RevalidateUtil] B2C no respondió al webhook:', err.message || 'Error desconocido');
    });
    
  } catch (error) {
    console.error('[RevalidateUtil] Error interno al disparar revalidación', error);
  }
};