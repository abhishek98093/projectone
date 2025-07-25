const pool=require('../config/db');
const bcrypt =require('bcrypt');
require('dotenv').config();


const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER, 
    pass: process.env.EMAIL_PASS  
  }
});

const submitVerification = async (req, res) => {
  try {
    const {
      user_id,
      dob,
      gender,
      phone_number,
      aadhaar_number,
      address_line1,
      address_line2,
      town,
      district,
      state,
      pincode,
      aadhaar_front_url,
      aadhaar_back_url,
      profile_picture_url,
    } = req.body.data;

    if (!user_id) {
      return res.status(400).json({ success: false, message: "User ID is required." });
    }

    // Aadhaar validation
    if (!aadhaar_number) {
      return res.status(400).json({
        success: false,
        message: "Aadhaar number is required",
      });
    }

    const cleanedAadhaar = String(aadhaar_number).replace(/\D/g, '');

    if (cleanedAadhaar.length !== 12) {
      return res.status(400).json({
        success: false,
        message: "Aadhaar must be exactly 12 digits",
      });
    }

    if (!/^[2-9]/.test(cleanedAadhaar)) {
      return res.status(400).json({
        success: false,
        message: "Aadhaar must start with digits 2-9",
      });
    }
    

    // SQL UPDATE with RETURNING *
    const result = await pool.query(
      `UPDATE users SET
        dob = $1,
        gender = $2,
        phone_number = $3,
        aadhaar_number = $4,
        address_line1 = $5,
        address_line2 = $6,
        town = $7,
        district = $8,
        state = $9,
        pincode = $10,
        aadhaar_front_url = $11,
        aadhaar_back_url = $12,
        profile_picture_url = $13,
        is_profile_complete = TRUE,
        verification_status = 'pending',
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $14
      RETURNING *;`,
      [
        dob,
        gender,
        phone_number,
        cleanedAadhaar,
        address_line1,
        address_line2,
        town,
        district,
        state,
        pincode,
        aadhaar_front_url,
        aadhaar_back_url,
        profile_picture_url,
        user_id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    // ✅ Remove password from updated user before sending
    const { password: _, ...safeUser } = result.rows[0];

    return res.status(200).json({
      success: true,
      message: "Verification details submitted successfully.",
      user: safeUser,
    });

  } catch (err) {
    console.error("❌ Error in submitVerification:", err.stack);
    return res.status(500).json({
      success: false,
      message: "Server error while updating verification details.",
    });
  }
};



const submitComplaint = async (req, res) => {
  try {
    const {
      crime_type,
      description,
      location_address,
      town,
      district,
      state,
      pincode,
      crime_datetime,
      proof_urls,
      title
    } = req.body;

    const user_id = req.user?.user_id; 

    if (!user_id || !crime_type || !crime_datetime) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: crime_type or crime_datetime.",
      });
    }

    const result = await pool.query(
  `INSERT INTO complaints (
    user_id,
    crime_type,
    description,
    location_address,
    town,
    district,
    state,
    pincode,
    crime_datetime,
    proof_urls,
    status,
    created_at,
    updated_at,
    title
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $11
  ) RETURNING *`,
  [
    user_id,
    crime_type,
    description || '',
    location_address || '',
    town || '',
    district || '',
    state || '',
    pincode || '',
    crime_datetime,
    proof_urls || [],
    title || ''
  ]
);


    return res.status(201).json({
      success: true,
      message: "Complaint submitted successfully.",
      complaint: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Error submitting complaint:", err.stack);
    return res.status(500).json({
      success: false,
      message: "Server error while submitting complaint.",
    });
  }
};


const getComplaint = async (req, res) => {

  try {
    const id = req.user.user_id;

    const result = await pool.query(
      'SELECT * FROM complaints WHERE user_id = $1 ORDER BY created_at DESC',
      [id]
    );

    if (result.rows.length === 0) {
  return res.status(200).json({
    success: true,
    message: 'No complaints found for this user.',
    complaints: [],
  });
}

    return res.status(200).json({
      success: true,
      complaints: result.rows,
    });
  } catch (error) {
    console.error("❌ Error fetching complaints:", error.stack);
    return res.status(500).json({
      success: false,
      message: 'Server error while fetching complaints.',
    });
  }
};


const deleteComplaint = async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.user_id; // assuming user_id is attached to req.user by your auth middleware

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized: User not authenticated' });
  }

  try {
    // Check if the complaint exists and belongs to this user
    const result = await pool.query(
      'DELETE FROM complaints WHERE complaint_id = $1 AND user_id = $2 RETURNING *',
      [id, userId]
    );

    if (result.rowCount > 0) {
      res.status(200).json({ success: true, message: 'Complaint deleted successfully' });
    } else {
      res.status(404).json({ success: false, message: 'Complaint not found or you do not have permission to delete this complaint' });
    }
  } catch (error) {
    console.error('Error deleting complaint:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};


const getAllMissingAndCriminalsForUser = async (req, res) => {
  try {
    const user_id = req.user.user_id;
    let { pincode } = req.query; // get pincode from query

    // If pincode not provided in query, fetch user's registered pincode
    if (!pincode) {
      const userResult = await pool.query(
        'SELECT pincode FROM users WHERE user_id = $1',
        [user_id]
      );

      if (userResult.rows.length === 0) {
        return res.status(403).json({ error: "User account not found." });
      }

      pincode = userResult.rows[0].pincode;

      if (!pincode) {
        return res.status(400).json({ error: "No pincode provided and user profile has no pincode. Please update your profile with pincode." });
      }
    }

    // Fetch missing persons
    const missingQuery = `
      SELECT * FROM missing_persons
      WHERE pincode = $1
      ORDER BY created_at DESC
    `;
    const missingResult = await pool.query(missingQuery, [pincode]);

    // Fetch criminals
    const criminalQuery = `
      SELECT * FROM criminals
      WHERE pincode = $1
      ORDER BY created_at DESC
    `;
    const criminalResult = await pool.query(criminalQuery, [pincode]);

    // Return response
    res.status(200).json({
      success: true,
      pincode_used: pincode, // optional: show which pincode was used
      missing_persons: missingResult.rows,
      criminals: criminalResult.rows
    });

  } catch (err) {
    console.error("Error fetching data for user:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};


const submitLead = async (req, res) => {
  try {
    const {
      title,
      media_urls,
      description,
      incident_datetime, // added
      location_address,
      town,
      district,
      state,
      pincode,
      country,
      anonymous
    } = req.body;

    if (!media_urls || typeof media_urls !== 'object' || Object.keys(media_urls).length > 3) {
      return res.status(400).json({ message: 'media_urls must be an object with up to 3 URLs' });
    }

    if (!incident_datetime) {
      return res.status(400).json({ message: 'incident_datetime is required' });
    }
    const parsedIncidentDatetime = new Date(incident_datetime);
    if (isNaN(parsedIncidentDatetime.getTime())) {
      return res.status(400).json({ message: 'Invalid incident_datetime format' });
    }

    // ✅ Determine user_id based on anonymous flag
    let user_id = null;
    const isAnonymous = anonymous || false;
    if (!isAnonymous) {
      user_id = req.user && req.user.user_id ? req.user.user_id : null;
    }

    const insertQuery = `
      INSERT INTO leads
      (user_id, title, media_urls, description, incident_datetime, location_address, town, district, state, pincode, country, anonymous)
      VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *;
    `;

    const values = [
      user_id, // can be null if anonymous
      title,
      media_urls,
      description,
      parsedIncidentDatetime, // added parsed date
      location_address,
      town,
      district,
      state,
      pincode,
      country || 'India',
      isAnonymous
    ];

    const result = await pool.query(insertQuery, values);

    res.status(201).json({
      message: 'Lead submitted successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error submitting lead:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

const getTopContributorsInArea = async (req, res) => {
  try {
    const userId = req.user.user_id;

    // ✅ Fetch user's pincode first
    const userResult = await pool.query(
      `SELECT pincode, contribution_points, name, profile_picture_url FROM users WHERE user_id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: 'User not found', data: [] });
    }

    const userPincode = userResult.rows[0].pincode;

    if (!userPincode) {
      return res.status(200).json({
        message: 'User has no pincode registered',
        data: []
      });
    }

    // ✅ Fetch top 15 contributors in that pincode
    const topContributorsResult = await pool.query(
      `SELECT user_id, name, profile_picture_url, contribution_points 
       FROM users 
       WHERE pincode = $1 
       ORDER BY contribution_points DESC 
       LIMIT 15`,
      [userPincode]
    );

    const topContributors = topContributorsResult.rows || [];

    // ✅ Check if user is already in top 15
    const userInTop = topContributors.some(u => u.user_id === userId);

    if (!userInTop) {
      // ✅ Fetch user's rank in that pincode only if not in top 15
      const userRankResult = await pool.query(
        `SELECT user_id, name, profile_picture_url, contribution_points
         FROM users
         WHERE pincode = $1
         ORDER BY contribution_points DESC`,
        [userPincode]
      );

      const fullList = userRankResult.rows || [];
      const userIndex = fullList.findIndex(u => u.user_id === userId);

      if (userIndex !== -1) {
        // ✅ Add user as 16th record with rank
        topContributors.push({
          ...fullList[userIndex],
          rank: userIndex + 1
        });
      }
    }

    res.status(200).json({
      message: 'Top contributors fetched successfully',
      data: topContributors
    });

  } catch (error) {
    console.error('Error fetching top contributors:', error);
    res.status(500).json({ message: 'Internal Server Error', data: [] });
  }
};


const createSightingUpdate = async (req, res) => {
  try {
    const {
      type,
      ref_id,
      update_text,
      proof_url,
      address,
      pincode,
      district,
      time_of_sighting,
    } = req.body;

    const { user_id, user_role } = req.user; // 🔥 From JWT (not frontend)

    if (
      !type || !ref_id || !update_text || !proof_url ||
      !address || !pincode || !district || !time_of_sighting
    ) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const insertQuery = `
      INSERT INTO updates (
        type, ref_id, updated_by, updated_by_role,
        update_text, proof_url, address, pincode, district, time_of_sighting
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `;

    const values = [
      type,
      ref_id,
      user_id,
      user_role,
      update_text,
      proof_url,
      address,
      pincode,
      district,
      time_of_sighting,
    ];

    const result = await pool.query(insertQuery, values);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Error in createSightingUpdate:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};







module.exports={createSightingUpdate,getTopContributorsInArea,submitLead,getAllMissingAndCriminalsForUser,submitVerification,submitComplaint,getComplaint,deleteComplaint}