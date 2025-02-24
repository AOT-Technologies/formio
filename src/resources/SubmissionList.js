const { ObjectId } = require("../util/util");

module.exports = {
  getAllSubmissions: (router) =>
    async function (req, res, next) {
      try { 
        const userRoles = req.user.roles.map((id) => ObjectId(id)); 

        // submissionIds taking from req.body
        const submissionIds = req.body.id
          ? req.body.id.map((id) => ObjectId(id.trim()))
          : []; 

          const pipeline = [
            {
              $match: {
                _id: { $in: submissionIds }, // Filter by submission IDs
              },
            },
            {
              $lookup: {
                from: "forms",
                localField: "form",
                foreignField: "_id",
                as: "formDetails",
              },
            },
            {
              $unwind: "$formDetails",
            },
            {
              $match: {
                $or: [
                  {
                    "formDetails.submissionAccess": {
                      $elemMatch: {
                        type: "read_all",
                        roles: { $in: userRoles },
                      },
                    },
                  },
                  {
                    owner: ObjectId(req.user._id), // User must be the owner for read_own
                  },
                ],
              },
            },
          ];
        // mongo query execute
        router.formio.resources.submission.model.aggregate(pipeline).then((result)=>res.json(result))
      } catch (error) {
        next(error);
      }
    },
};
