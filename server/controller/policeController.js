const pool = require('../config/db');
const bcrypt = require('bcrypt');
require('dotenv').config();

const getPoliceComplaints = async (req, res) => {
  const user_id = req.user.user_id;
  

  try {
    const policeResult = await pool.query(
      'SELECT * FROM police_details WHERE user_id = $1',
      [user_id]
    );
    const police = policeResult.rows[0];

    if (!police) {
      return res.status(404).json({
        success: false,
        message: 'Police officer not found',
      });
    }

    let complaints = [];
    let subInspectors = []; 
    if (police.rank === 'Sub-Inspector') {
      const complaintResult = await pool.query(
        'SELECT * FROM complaints WHERE assigned_badge = $1',
        [police.badge_number]
      );
      complaints = complaintResult.rows;

    } else if (police.rank === 'Inspector') {
      const userResult = await pool.query(
        'SELECT pincode FROM users WHERE user_id = $1',
        [user_id]
      );
      const pincode = userResult.rows[0]?.pincode; 

      if (!pincode) {
        return res.status(400).json({
          success: false,
          message: 'Inspector station pincode not available in user profile',
        });
      }

      const complaintResult = await pool.query(
        'SELECT * FROM complaints WHERE pincode = $1',
        [pincode]
      );
      complaints = complaintResult.rows;

      const subInspectorResult = await pool.query(
        `
        SELECT u.profile_picture_url,u.user_id, u.name, p.police_id, p.badge_number
        FROM police_details p
        JOIN users u ON p.user_id = u.user_id
        WHERE p.station_pincode = $1 AND p.rank = 'Sub-Inspector'
        `,
        [pincode]
      );
      subInspectors = subInspectorResult.rows;
      const badgeNumbers = subInspectors.map(si => si.badge_number);

      if (badgeNumbers.length > 0) {
        const countsResult = await pool.query(
          `
          SELECT assigned_badge, status, COUNT(*) as count
          FROM complaints
          WHERE assigned_badge = ANY($1)
          GROUP BY assigned_badge, status
          `,
          [badgeNumbers]
        );

        const countsMap = {};
        countsResult.rows.forEach(row => {
          const badge = row.assigned_badge;
          const status = row.status; 
          const count = parseInt(row.count); 

          if (!countsMap[badge]) {
            countsMap[badge] = {
              pending: 0,
              'in-progress': 0,
              resolved: 0,
              rejected: 0,
              total: 0 
            };
          }

          countsMap[badge][status] = count;
          countsMap[badge].total += count;
        });

        subInspectors = subInspectors.map(si => ({
          ...si,
          complaintCounts: countsMap[si.badge_number] || { 
            pending: 0,
            'in-progress': 0,
            resolved: 0,
            rejected: 0,
            total: 0
          }
        }));
      }

    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid police rank',
      });
    }
    return res.status(200).json({
      success: true,
      message: 'Complaints fetched successfully',
      complaints: complaints,
      subInspectors: subInspectors 
    });

  } catch (err) {
    console.error("getPoliceComplaints error:", err);
    return res.status(500).json({
      success: false,
      message: 'Error fetching complaints',
      error: err.message, 
    });
  }
};



const assignOfficerToComplaint = async (req, res) => {
  const { police_id, complaint_id } = req.body;

  if (!police_id || !complaint_id) {
    return res.status(400).json({
      success: false,
      message: "Both police_id and complaint_id are required",
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const policeResult = await client.query(
      `SELECT pd.police_id, pd.badge_number, pd.station_pincode, pd.rank,
              u.name, u.email
       FROM police_details pd
       JOIN users u ON pd.user_id = u.user_id
       WHERE pd.police_id = $1 AND pd.rank = 'Sub-Inspector'`,
      [police_id]
    );

    if (policeResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: "Sub-Inspector not found with the given police_id",
      });
    }

    const police = policeResult.rows[0];

    const complaintResult = await client.query(
      `SELECT complaint_id, pincode, status
       FROM complaints
       WHERE complaint_id = $1`,
      [complaint_id]
    );

    if (complaintResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: "Complaint not found",
      });
    }

    const complaint = complaintResult.rows[0];

    if (complaint.pincode !== police.station_pincode) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: "Police station pincode does not match complaint pincode",
      });
    }

    const newRemark = `Assigned to Sub-Inspector: ${police.name} (Email: ${police.email}, Badge: ${police.badge_number})`;

    const updateResult = await client.query(
      `UPDATE complaints
       SET status = 'in-progress',
           assigned_badge = $1,
           remark = $2,
           updated_at = NOW()
       WHERE complaint_id = $3
       RETURNING *`,
      [police.badge_number, newRemark, complaint_id]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      message: "Complaint assigned successfully to Sub-Inspector",
      complaint: updateResult.rows[0],
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error assigning officer:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

const addMissingPerson = async (req, res) => {
  try {
    const police_user_id = req.user.user_id;

    const policeResult = await pool.query(
      'SELECT police_id, station_pincode FROM police_details WHERE user_id = $1',
      [police_user_id]
    );

    if (policeResult.rows.length === 0) {
      return res.status(403).json({ error: "Police account not found." });
    }

    const police_id = policeResult.rows[0].police_id;
    const registered_pincode = policeResult.rows[0].station_pincode;

    const {
      name,
      age,
      gender,
      description,
      profile_picture_url,
      last_seen_location,
      last_seen_time,
      probable_location,  
      address,
      district,
      pincode,
      reward_on_information = 0
    } = req.body;

    if (!Number.isInteger(reward_on_information)) {
      return res.status(400).json({
        error: "Invalid 'reward_on_information'. It must be an integer."
      });
    }

    const insertQuery = `
      INSERT INTO missing_persons (
        name, age, gender, description,
        profile_picture_url,
        last_seen_location, last_seen_time,
        probable_location,       -- 🔥 Added here
        address, district, pincode,
        registered_pincode,
        added_by,
        reward_on_information
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *;
    `;

    const result = await pool.query(insertQuery, [
      name,
      age,
      gender,
      description,
      profile_picture_url,
      last_seen_location,
      last_seen_time,
      probable_location,      // 🔥 Added here
      address,
      district,
      pincode,
      registered_pincode,
      police_id,
      reward_on_information
    ]);

    res.status(201).json({
      message: "Missing person added successfully",
      data: result.rows[0]
    });

  } catch (err) {
    console.error("Error adding missing person:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

const addCriminal = async (req, res) => {
  try {
    const police_user_id = req.user.user_id;

    // Get police_id and station_pincode from police_details
    const policeResult = await pool.query(
      'SELECT police_id, station_pincode FROM police_details WHERE user_id = $1',
      [police_user_id]
    );

    if (policeResult.rows.length === 0) {
      return res.status(403).json({ error: "Police account not found." });
    }

    const police_id = policeResult.rows[0].police_id;
    const registered_pincode = policeResult.rows[0].station_pincode;

    const {
      name,
      description,
      profile_picture_url,
      last_seen_location,
      last_seen_time,
      probable_location,
      address,
      district,
      pincode,
      star = 1, // default to 1
      reward_on_information = 0, // default to 0
      age = null,
      gender = null
    } = req.body;

    // ⭐️ Validate star
    if (isNaN(star) || star < 1 || star > 5) {
      return res.status(400).json({
        error: "Invalid 'star' value. It must be an integer between 1 and 5."
      });
    }

    // 💰 Validate reward_on_information
    if (!Number.isInteger(reward_on_information)) {
      return res.status(400).json({
        error: "Invalid 'reward_on_information'. It must be an integer."
      });
    }

    // 🔢 Validate age if provided
    if (age !== null && (!Number.isInteger(age) || age < 0 || age > 150)) {
      return res.status(400).json({
        error: "Invalid 'age'. It must be an integer between 0 and 150."
      });
    }

    // ⚧️ Validate gender if provided
    const validGenders = ['male', 'female', 'other'];
    if (gender !== null && !validGenders.includes(gender.toLowerCase())) {
      return res.status(400).json({
        error: "Invalid 'gender'. Allowed values are 'male', 'female', or 'other'."
      });
    }

    const insertQuery = `
      INSERT INTO criminals (
        name, description,
        profile_picture_url,
        last_seen_location, last_seen_time,
        probable_location,
        address, district, pincode,
        registered_pincode,
        added_by,
        star,
        reward_on_information,
        age,
        gender
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *;
    `;

    const result = await pool.query(insertQuery, [
      name,
      description,
      profile_picture_url,
      last_seen_location,
      last_seen_time,
      probable_location,
      address,
      district,
      pincode,
      registered_pincode,
      police_id,
      star,
      reward_on_information,
      age,
      gender
    ]);

    res.status(201).json({
      message: "Criminal added successfully",
      data: result.rows[0]
    });

  } catch (err) {
    console.error("Error adding criminal:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};


const getAllMissingAndCriminals = async (req, res) => {
    try {
        const police_user_id = req.user.user_id;

        // 1. Get station_pincode from police_details
        const policeResult = await pool.query(
            'SELECT station_pincode FROM police_details WHERE user_id = $1',
            [police_user_id]
        );
        if (policeResult.rows.length === 0) {
            return res.status(403).json({ error: "Police account not found." });
        }
        const station_pincode = policeResult.rows[0].station_pincode;

        // 2. Fetch missing persons with same registered_pincode
        const missingQuery = `
            SELECT * FROM missing_persons
            WHERE registered_pincode = $1
            ORDER BY created_at DESC
        `;
        const missingResult = await pool.query(missingQuery, [station_pincode]);

        // 3. Fetch criminals with same registered_pincode
        const criminalQuery = `
            SELECT * FROM criminals
            WHERE registered_pincode = $1
            ORDER BY created_at DESC
        `;
        const criminalResult = await pool.query(criminalQuery, [station_pincode]);

        // 4. Return combined response
        res.status(200).json({
            success:true,
            missing_persons: missingResult.rows,
            criminals: criminalResult.rows
        });

    } catch (err) {
        console.error("Error fetching data:", err);
        res.status(500).json({ error: "Internal server error" });
    }
};



const deleteMissingPerson = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM missing_persons WHERE missing_id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Missing person not found" });
    }
    res.status(200).json({
      message: "Missing person deleted successfully",
      data: result.rows[0]
    });
  } catch (err) {
    console.log(err);
    console.error("Error deleting missing person:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ✅ Delete Criminal by ID (criminal_id remains same)
const deleteCriminal = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM criminals WHERE criminal_id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Criminal not found" });
    }

    res.status(200).json({
      message: "Criminal deleted successfully",
      data: result.rows[0]
    });
  } catch (err) {
    console.error("Error deleting criminal:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};


const updateMissingPerson = async (req, res) => {
  try {
    const { id } = req.params; 
    const {
      probable_location,
      pincode,
      last_seen_location,
      last_seen_time,
      description,
      reward_on_information,
      status
    } = req.body;

    
    const fields = [];
    const values = [];
    let count = 1;

    if (probable_location !== undefined) {
      fields.push(`probable_location = $${count++}`);
      values.push(probable_location);
    }

    if (pincode !== undefined) {
      fields.push(`pincode = $${count++}`);
      values.push(pincode);
    }

    if (last_seen_location !== undefined) {
      fields.push(`last_seen_location = $${count++}`);
      values.push(last_seen_location);
    }

    if (last_seen_time !== undefined) {
      fields.push(`last_seen_time = $${count++}`);
      values.push(last_seen_time);
    }

    if (description !== undefined) {
      fields.push(`description = $${count++}`);
      values.push(description);
    }

    if (reward_on_information !== undefined) {
      const intReward = parseInt(reward_on_information);
      if (isNaN(intReward)) {
        return res.status(400).json({
          error: "'reward_on_information' must be an integer."
        });
      }
      fields.push(`reward_on_information = $${count++}`);
      values.push(intReward);
    }

    if (status !== undefined) {
      if (!['active', 'found', 'closed'].includes(status)) {
        return res.status(400).json({ error: "Invalid status value" });
      }
      fields.push(`status = $${count++}`);
      values.push(status);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: "No valid fields to update." });
    }

    values.push(id);

    const updateQuery = `
      UPDATE missing_persons
      SET ${fields.join(', ')}
      WHERE missing_id = $${count}
      RETURNING *;
    `;

    const result = await pool.query(updateQuery, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Missing person not found" });
    }

    res.status(200).json({
      message: "Missing person updated successfully",
      data: result.rows[0]
    });

  } catch (err) {
    console.error("Error updating missing person:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};


const updateCriminal = async (req, res) => {
  try {
    const { id } = req.params; 

    const {
      description,
      last_seen_location,
      last_seen_time,
      probable_location,
      pincode,
      star,
      status,
      reward_on_information
    } = req.body;

    const fields = [];
    const values = [];
    let count = 1;

    if (description !== undefined) {
      fields.push(`description = $${count++}`);
      values.push(description);
    }

    if (last_seen_location !== undefined) {
      fields.push(`last_seen_location = $${count++}`);
      values.push(last_seen_location);
    }

    if (last_seen_time !== undefined) {
      fields.push(`last_seen_time = $${count++}`);
      values.push(last_seen_time);
    }

    if (probable_location !== undefined) {
      fields.push(`probable_location = $${count++}`);
      values.push(probable_location);
    }

    if (pincode !== undefined) {
      fields.push(`pincode = $${count++}`);
      values.push(pincode);
    }

    if (star !== undefined) {
      const intStar = parseInt(star);
      if (isNaN(intStar)) {
        return res.status(400).json({ error: "'star' must be an integer." });
      }
      fields.push(`star = $${count++}`);
      values.push(intStar);
    }

    if (reward_on_information !== undefined) {
      const intReward = parseInt(reward_on_information);
      if (isNaN(intReward)) {
        return res.status(400).json({ error: "'reward_on_information' must be an integer." });
      }
      fields.push(`reward_on_information = $${count++}`);
      values.push(intReward);
    }

    if (status !== undefined) {
      if (!['wanted', 'arrested', 'closed'].includes(status)) {
        return res.status(400).json({ error: "Invalid status value" });
      }
      fields.push(`status = $${count++}`);
      values.push(status);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: "No valid fields to update." });
    }

    values.push(id);

    const updateQuery = `
      UPDATE criminals
      SET ${fields.join(', ')}
      WHERE criminal_id = $${count}
      RETURNING *;
    `;

    const result = await pool.query(updateQuery, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Criminal not found" });
    }

    res.status(200).json({
      message: "Criminal updated successfully",
      data: result.rows[0]
    });

  } catch (err) {
    console.error("Error updating criminal:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getFilteredLeads = async (req, res) => {
  const {
    title,
    startDate,
    endDate,
    town,
    district,
    state,
    pincode,
    country,
  } = req.body;
  try {
    let query = 'SELECT * FROM leads WHERE 1=1';
    const values = [];

    if (title) {
      values.push(title);
      query += ` AND title = $${values.length}`;
    }

    if (startDate) {
      values.push(`${startDate} 00:00:00`);
      query += ` AND incident_datetime >= $${values.length}`;
    }

    if (endDate) {
      values.push(`${endDate} 23:59:59`);
      query += ` AND incident_datetime <= $${values.length}`;
    }

    if (town) {
      values.push(town);
      query += ` AND town ILIKE $${values.length}`;
    }

    if (district) {
      values.push(district);
      query += ` AND district ILIKE $${values.length}`;
    }

    if (state) {
      values.push(state);
      query += ` AND state ILIKE $${values.length}`;
    }

    if (pincode) {
      values.push(pincode);
      query += ` AND pincode = $${values.length}`;
    }

    if (country) {
      values.push(country);
      query += ` AND country ILIKE $${values.length}`;
    }

    query += ' ORDER BY incident_datetime DESC'; 

    const result = await pool.query(query, values);
    return res.status(200).json({ leads: result.rows });
  } catch (error) {
    console.error('Error fetching filtered leads:', error);
    return res.status(500).json({ message: 'Server error while fetching leads.' });
  }
};


const awardStar = async (req, res) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET contribution_points = contribution_points + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1
       RETURNING user_id, contribution_points`,
      [user_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.status(200).json({
      message: 'Contribution points increased by 1',
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Error in awardStar:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

const getLeadsByCriminalId = async (req, res) => {
  const { criminalId } = req.params;

  if (!criminalId) {
    return res.status(400).json({ message: 'Criminal ID is required.' });
  }

  try {
    let query = `
      SELECT 
        updated_by, 
        update_text, 
        proof_url, 
        address, 
        district, 
        pincode, 
        time_of_sighting 
      FROM updates 
      WHERE ref_id = $1 AND type = $2
      ORDER BY time_of_sighting DESC
    `;

    const values = [criminalId, 'criminal'];

    const result = await pool.query(query, values);
    return res.status(200).json({ leads: result.rows });
  } catch (error) {
    console.error('Error fetching criminal leads:', error);
    return res.status(500).json({ message: 'Server error while fetching leads.' });
  }
};

const getLeadsByMissingId = async (req, res) => {
  const { missingId } = req.params;

  if (!missingId) {
    return res.status(400).json({ message: 'Missing Person ID is required.' });
  }

  try {
    const query = `
      SELECT 
        updated_by, 
        update_text, 
        proof_url, 
        address, 
        district, 
        pincode, 
        time_of_sighting 
      FROM updates 
      WHERE ref_id = $1 AND type = $2
      ORDER BY time_of_sighting DESC
    `;

    const values = [missingId, 'missing'];
    const result = await pool.query(query, values);
    console.log(result.rows);
    return res.status(200).json({ leads: result.rows });

  } catch (error) {
    console.error('Error fetching missing person leads:', error);
    return res.status(500).json({ message: 'Server error while fetching leads.' });
  }
};
const updateComplaintStatus = async (req, res) => {
  console.log('requrest recieved');
  const { complaintId } = req.params;
  const { status, remark } = req.body;

  // Optional: Validate status field
  const validStatuses = ['pending', 'in-progress', 'resolved', 'rejected'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value.' });
  }

  try {
    const query = `
      UPDATE complaints
      SET status = $1,
          remark = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE complaint_id = $3
      RETURNING *;
    `;

    const values = [status, remark, complaintId];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Complaint not found.' });
    }
    console.log('request recieved');
    res.status(200).json({ success: true, updatedComplaint: result.rows[0] });
  } catch (err) {
    console.error('Error updating complaint status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const updateCaseFile = async (req, res) => {
  console.log('Update case file request received');

  const { complaintId } = req.params;
  const { case_file_url } = req.body;

  // Validate case_file_url
  if (typeof case_file_url !== 'string' || case_file_url.trim() === '') {
    return res.status(400).json({ error: 'Missing or invalid case_file_url in request body.' });
  }

  try {
    const query = `
      UPDATE complaints
      SET case_file_url = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE complaint_id = $2
      RETURNING *;
    `;

    const values = [case_file_url.trim(), complaintId];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Complaint not found.' });
    }

    return res.status(200).json({
      success: true,
      message: 'Case file updated successfully.',
      updatedComplaint: result.rows[0]
    });
  } catch (err) {
    console.error('Error updating case file:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

const getPendingUsersByPincode = async (req, res) => {
  const { pincode } = req.params;

  try {
    const query = `
      SELECT *
      FROM users
      WHERE pincode = $1 AND verification_status = 'pending';
    `;
    const result = await pool.query(query, [pincode]);

    res.status(200).json({ users: result.rows });
  } catch (err) {
    console.error('Error fetching pending users:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const updateVerificationStatus = async (req, res) => {
  const { userId } = req.params;
  const { status } = req.body;

  const validStatuses = ['verified', 'failed'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be "verified" or "failed".' });
  }

  try {
    let query, values;

    if (status === 'verified') {
      query = `
        UPDATE users
        SET verification_status = $1,
            aadhaar_verified = TRUE,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $2
        RETURNING user_id, verification_status, aadhaar_verified;
      `;
      values = [status, userId];
    } else {
      query = `
        UPDATE users
        SET verification_status = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $2
        RETURNING user_id, verification_status, aadhaar_verified;
      `;
      values = [status, userId];
    }

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.status(200).json({
      success: true,
      message: `User status updated to ${status}`,
      data: result.rows[0],
    });
  } catch (err) {
    console.error('Error updating verification status:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};



module.exports = {updateVerificationStatus, getPendingUsersByPincode,updateCaseFile, updateComplaintStatus,getLeadsByMissingId, getLeadsByCriminalId, awardStar,getFilteredLeads,updateCriminal,updateMissingPerson, getPoliceComplaints,assignOfficerToComplaint ,addCriminal,addMissingPerson,getAllMissingAndCriminals,deleteCriminal,deleteMissingPerson};