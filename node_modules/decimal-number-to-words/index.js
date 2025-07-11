
var converter = require('number-to-words');

function toWords(n){  
    if (!n) return ''
    if((/[^0-9.]/g).test(n)) return ''
    if(n <= 0) return ''

    var nums = n.toString().split('.')

    if(nums.length && nums[0] !== undefined )
    {
        var whole = converter.toWords(nums[0])

        if (nums.length == 2 && nums[1] !== '') {
            var fractionstr = nums[1].toString();
            var fraction = '';
            for(var i=0;i<fractionstr.length;i++){
                fraction = fraction+' ' + converter.toWords(fractionstr.charAt(i));
            }
            
            return whole + ' point' + fraction;
        } else {
            return whole;
        }
    }  
}

function toOrdinal(n)
{
    var whole = converter.toOrdinal(n);
    return whole;
}

function toWordsOrdinal(n)
{
    var whole = converter.toWordsOrdinal(n);
    return whole;
}
module.exports = {toWords, toOrdinal, toWordsOrdinal};