import { jwtDecode } from 'jwt-decode';


const getToken = () => {
    const result = localStorage.getItem("token");
    return result;
};

const getRole = () => {
    try {
        const token = localStorage.getItem("token");
        if (!token) return null;

        const decoded = jwtDecode(token);
        return decoded.user_role || null
    } catch (error) {
        console.error("Failed to decode token:", error);
        return null;
    }
};

const extractRole = (token) => {
    if (!token) return null;
    try {
        const decoded = jwtDecode(token);
        return decoded.user_role;
    } catch (error) {
        return null;
    }
};


 const getUserId = () => {
    const token = localStorage.getItem("token");
    if (!token) return null;
    try {
      const decoded = jwtDecode(token);
      console.log(decoded.user_id);
      return decoded.user_id;
    } catch (error) {
      return null;
    }
  };

 const isValidToken = () => {
  const token = localStorage.getItem("token");
  if (!token) return false;

  try {
    const decoded = jwtDecode(token);
    const currentTime = Math.floor(Date.now() / 1000);

    // Ensure decoded has exp field and is a number
    if (decoded && typeof decoded.exp === 'number') {
      return decoded.exp > currentTime;
    } else {
      console.error("Invalid token payload structure");
      return false;
    }

  } catch (err) {
    console.error("Token decoding error", err);
    return false;
  }
};
const clearAuth = () => {
    localStorage.removeItem("token");
};

export { getToken, getRole, extractRole, clearAuth,getUserId ,isValidToken};
