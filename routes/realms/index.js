require("dotenv").config();
const express = require("express");
const { jwtchecker } = require("../../reusables/hooks/jwthelper");
const pool = require("../../reusables/database/postgres");
const Storage = require("../../reusables/hooks/storage");
const multiparty = require("multiparty");
const fs = require("fs/promises");
const makeid = require("../../reusables/hooks/makeID");
const router = express.Router();

router.post("/upload-media", jwtchecker, async (req, res) => {
  const userID = req.params.userID;
  const id = req.params.id;

  new multiparty.Form().parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: err.message });

    try {
      const realm_id = fields.realm_id[0];
      const realm_type = fields.realm_type[0];
      const media_type = fields.media_type[0];
      const image = files.image[0].path;

      const { rows } = await pool.query(
        `
        SELECT 
            EXISTS (SELECT 1 FROM community_realm WHERE realm_id = $1) as realm_exists,
            EXISTS (
            SELECT 1 
            FROM community_member cm
            JOIN community_realm cr ON cm.realm_id = cr.realm_id
            WHERE cr.realm_id = $1 
                AND cm.account_id = $2 
                AND cm.role = 'admin'
            ) as is_admin
        `,
        [realm_id, id],
      );

      if (media_type !== "profile" && media_type !== "cover_photo") {
        throw new Error("Media type mismatch");
      }

      if (rows.length <= 0) {
        throw new Error("Realm does not exist");
      }

      if (!rows[0].realm_exists || !rows[0].is_admin) {
        throw new Error("You do not have permission to make this action.");
      }

      const imageBuffer = await fs.readFile(image);

      const imageUpload = await Storage.upload(
        `${makeid(10)}_${files.image[0].originalFilename}`,
        imageBuffer,
        `uploads/${realm_type}s/${realm_id}`,
      );

      if (imageUpload) {
        if (media_type === "profile") {
          await pool.query(
            `UPDATE community_realm
                        SET profile = $1
                        WHERE realm_id = $2
                      `,
            [imageUpload, realm_id],
          );
        }

        if (media_type === "cover_photo") {
          await pool.query(
            `UPDATE community_realm
                        SET cover_photo = $1
                        WHERE realm_id = $2
                      `,
            [imageUpload, realm_id],
          );
        }
        res.send({
          status: true,
          message: `Upload successful!`,
          details: { media_type, url: imageUpload },
        });
      } else {
        throw new Error("Error occured during upload");
      }
    } catch (ex) {
      res
        .status(500)
        .send({ status: false, message: ex.message || ex.toString() });
      console.log(ex);
    }
  });
});

module.exports = router;
